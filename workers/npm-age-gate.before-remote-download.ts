// GENERATED — DO NOT EDIT. Run `npm run build` to regenerate.
// Authored source: workers/src/core.template.ts (spine) +
// workers/src/ecosystems/<system>.ts (parser, injected below) +
// allowlist.json (inlined below).
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

// <generated:ecosystem> — DO NOT EDIT BY HAND. Source: workers/src/ecosystems/npm.ts.
// Regenerate with: npm run build:workers
const SYSTEM = "npm";

// npm remote layout: [@scope/]name/-/<unscoped-name>-<version>.tgz
function parse(path: string): { name: string; version: string } | undefined {
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
// </generated:ecosystem>

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

  const parsed = parse(repoPath.path);

  // Cannot evaluate (unrecognized path layout): fail closed. We cannot reason
  // about the package age, so block rather than let an unevaluated download
  // through. This worker is scoped to one ecosystem (manifest repoKeys); keep it
  // pointed at remotes whose layout it parses so this branch does not block
  // legitimate traffic.
  if (!parsed) {
    return {
      status: ActionStatus.STOP,
      message: `Package age gate blocked ${repoPath.key}:${repoPath.path} (unparseable-path); cannot evaluate package age.`,
      requestHeaders: {}
    };
  }

  const packageLabel = `${SYSTEM}:${parsed.name}@${parsed.version}`;

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

  const versionUrl = `${DEPS_DEV_BASE_URL}/v3/systems/${SYSTEM}/packages/${encodeURIComponent(parsed.name)}/versions/${encodeURIComponent(parsed.version)}`;

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
