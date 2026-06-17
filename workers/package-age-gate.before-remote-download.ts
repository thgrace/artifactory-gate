const MINIMUM_PACKAGE_AGE_HOURS = 48;
const API_TIMEOUT_MS = 2500;
const DEPS_DEV_BASE_URL = "https://api.deps.dev";

// <generated:allowlist> — DO NOT EDIT BY HAND. Source: allowlist.json.
// Regenerate with: npm run build:allowlist
const ALLOWLIST = new Set([]);
// </generated:allowlist>

function safeString(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

// Map an Artifactory repo key to a deps.dev system. Only npm and PyPI are
// supported; anything else returns undefined, which makes the Worker fail
// closed (STOP) because it cannot evaluate the package age. Keep the Worker
// scoped (manifest repoKeys) to remotes whose layout it parses.
function detectEcosystem(repoKey: any): string | undefined {
  const key = safeString(repoKey)?.toLowerCase() || "";
  if (key.includes("npm")) return "npm";
  if (key.includes("pypi") || key.includes("pip")) return "pypi";
  return undefined;
}

// PEP 503 normalization: lowercase and collapse runs of -, _, . to a single -.
function normalizePyPiName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

// npm remote layout: [@scope/]name/-/<unscoped-name>-<version>.tgz
function parseNpm(path: string): { name: string; version: string } | undefined {
  const marker = "/-/";
  const markerIndex = path.indexOf(marker);
  if (markerIndex === -1) return undefined;

  const name = path.slice(0, markerIndex).replace(/^\/+/, "");
  let filename = path.slice(markerIndex + marker.length);
  if (filename.endsWith(".tgz")) filename = filename.slice(0, -4);
  else if (filename.endsWith(".tar.gz")) filename = filename.slice(0, -7);
  else return undefined;

  const unscoped = name.slice(name.lastIndexOf("/") + 1);
  const prefix = `${unscoped}-`;
  if (!name || !filename.startsWith(prefix)) return undefined;

  const version = filename.slice(prefix.length);
  if (!version) return undefined;
  return { name, version };
}

// PyPI remote layouts: wheels (<name>-<version>-...whl) and sdists
// (<name>-<version>.tar.gz | .tar.bz2 | .zip).
function parsePyPI(path: string): { name: string; version: string } | undefined {
  const filename = path.slice(path.lastIndexOf("/") + 1);

  if (filename.endsWith(".whl")) {
    const parts = filename.slice(0, -4).split("-");
    if (parts.length < 2) return undefined;
    return { name: normalizePyPiName(parts[0]), version: parts[1] };
  }

  const sdistExts = [".tar.gz", ".tar.bz2", ".zip"];
  const ext = sdistExts.find((candidate) => filename.endsWith(candidate));
  if (!ext) return undefined;

  const stem = filename.slice(0, -ext.length);
  const splitIndex = stem.lastIndexOf("-");
  if (splitIndex <= 0) return undefined;

  const name = stem.slice(0, splitIndex);
  const version = stem.slice(splitIndex + 1);
  if (!name || !version) return undefined;
  return { name: normalizePyPiName(name), version };
}

function computeAgeHours(publishedAt: any, now: number): number | undefined {
  const publishedString = safeString(publishedAt);
  if (!publishedString) return undefined;
  const publishedMs = Date.parse(publishedString);
  if (Number.isNaN(publishedMs)) return undefined;
  return (now - publishedMs) / 3600000;
}

export default async (
  context: PlatformContext,
  data: BeforeRemoteDownloadRequest
): Promise<BeforeRemoteDownloadResponse> => {
  const repoPath = data?.metadata?.repoPath;

  if (!repoPath) {
    return {
      status: ActionStatus.STOP,
      message: "Package age gate blocked request: missing repoPath metadata.",
      requestHeaders: {}
    };
  }

  // These request shapes often occur during package manager resolution/probing.
  // Do not block them here; the actual content GET will still be gated.
  if (data?.metadata?.headOnly || data?.metadata?.checksum || data?.metadata?.metadata) {
    return {
      status: ActionStatus.PROCEED,
      message: "Package age gate skipped non-content request.",
      requestHeaders: {}
    };
  }

  const system = detectEcosystem(repoPath.key);
  const parsed =
    system === "npm" ? parseNpm(repoPath.path) :
    system === "pypi" ? parsePyPI(repoPath.path) :
    undefined;

  // Cannot evaluate (unsupported ecosystem or unrecognized path layout): fail
  // closed. We cannot reason about the package age, so block rather than let an
  // unevaluated download through. Keep this Worker scoped (manifest repoKeys) to
  // remotes whose layout it parses, so this branch does not block legitimate
  // traffic on ecosystems the gate was never meant to cover.
  if (!system || !parsed) {
    const tag = system ? "unparseable-path" : "unsupported-ecosystem";
    return {
      status: ActionStatus.STOP,
      message: `Package age gate blocked ${repoPath.key}:${repoPath.path} (${tag}); cannot evaluate package age.`,
      requestHeaders: {}
    };
  }

  const packageLabel = `${system}:${parsed.name}@${parsed.version}`;

  // Operational exception: an exact name@version pin in the allowlist bypasses
  // the gate entirely (skip deps.dev, skip age and 404/transport fail-closed).
  // The allowlist is inlined from allowlist.json by scripts/build-allowlist.mjs.
  if (ALLOWLIST.has(packageLabel)) {
    return {
      status: ActionStatus.PROCEED,
      message: `Package age gate allowed ${packageLabel} via allowlist.`,
      requestHeaders: {}
    };
  }

  const versionUrl = `${DEPS_DEV_BASE_URL}/v3/systems/${system}/packages/${encodeURIComponent(parsed.name)}/versions/${encodeURIComponent(parsed.version)}`;

  // The JFrog Workers sandbox axios rejects the `timeout` request option
  // ("Setting 'timeout' in request is not allowed"), and the sandbox does not
  // expose `AbortController`/`setTimeout`, so no client-side request deadline is
  // available here. There is no manifest field to set an execution deadline
  // either (the manifest schema has no duration option), so a hung request is
  // bounded only by the platform-internal worker execution limit, whose
  // timeout-kill behavior (block vs. proceed) is not controlled by this Worker.
  // API_TIMEOUT_MS is kept as the documented intended deadline for when a
  // supported mechanism exists.
  void API_TIMEOUT_MS;

  try {
    const response = await context.clients.axios.get(versionUrl);

    const ageHours = computeAgeHours(response?.data?.publishedAt, Date.now());

    if (ageHours === undefined) {
      // deps.dev answered but carried no usable publishedAt: we cannot establish
      // the version age, so fail closed rather than proceed on an unknown age.
      return {
        status: ActionStatus.STOP,
        message: `Package age gate blocked ${packageLabel}; deps.dev returned no usable publish time, cannot evaluate package age.`,
        requestHeaders: {}
      };
    }

    const ageHoursLabel = ageHours.toFixed(1);

    if (ageHours >= MINIMUM_PACKAGE_AGE_HOURS) {
      return {
        status: ActionStatus.PROCEED,
        message: `Package age gate allowed ${packageLabel}; age_hours=${ageHoursLabel}; minimum_age_hours=${MINIMUM_PACKAGE_AGE_HOURS}`,
        requestHeaders: {}
      };
    }

    return {
      status: ActionStatus.STOP,
      message: `Package age gate blocked ${packageLabel}; age_hours=${ageHoursLabel}; minimum_age_hours=${MINIMUM_PACKAGE_AGE_HOURS}`,
      requestHeaders: {}
    };
  } catch (error) {
    const err: any = error;
    const errStatus = err?.status || err?.response?.status;

    // deps.dev returns 404 when it has no record of this version, which is the
    // freshly-published case the gate exists to catch. Fail closed: treat an
    // unknown version as a block.
    if (errStatus === 404) {
      return {
        status: ActionStatus.STOP,
        message: `Package age gate blocked ${packageLabel}; deps.dev has no record of this version (not yet indexed); minimum_age_hours=${MINIMUM_PACKAGE_AGE_HOURS}`,
        requestHeaders: {}
      };
    }

    const errMessage = err?.message || "unknown error";

    return {
      status: ActionStatus.STOP,
      message: `Package age gate blocked request because deps.dev lookup failed. status=${errStatus || "none"}; error=${errMessage}`,
      requestHeaders: {}
    };
  }
};