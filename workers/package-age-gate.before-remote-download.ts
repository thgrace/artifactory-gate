const MINIMUM_PACKAGE_AGE_HOURS = 48;
const DEFAULT_MODE = "enforce";
const API_TIMEOUT_MS = 2500;

function safeString(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function normalizeMode(rawMode: any): "enforce" | "audit" {
  const mode = safeString(rawMode)?.trim().toLowerCase();
  if (mode === "audit") return "audit";
  return "enforce";
}

function formatPackageLabel(verdict: any, repoPath: any): string {
  if (verdict?.ecosystem && verdict?.package_name && verdict?.version) {
    return `${verdict.ecosystem}:${verdict.package_name}@${verdict.version}`;
  }

  if (repoPath?.key && repoPath?.path) {
    return `${repoPath.key}:${repoPath.path}`;
  }

  return "unknown-package";
}

function buildHeaders(token: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

export default async (
  context: PlatformContext,
  data: BeforeRemoteDownloadRequest
): Promise<BeforeRemoteDownloadResponse> => {
  const requestHeaders: { [key: string]: Header } = {};

  const repoPath = data?.metadata?.repoPath;
  const originalRepoPath = data?.metadata?.originalRepoPath || repoPath;

  if (!repoPath) {
    return {
      status: ActionStatus.STOP,
      message: "Package age gate blocked request: missing repoPath metadata.",
      requestHeaders
    };
  }

  // These request shapes often occur during package manager resolution/probing.
  // Do not block them here; the actual content GET will still be gated.
  if (data?.metadata?.headOnly || data?.metadata?.checksum || data?.metadata?.metadata) {
    requestHeaders["X-Package-Age-Gate"] = { value: ["skipped-non-content-request"] };
    return {
      status: ActionStatus.PROCEED,
      message: "Package age gate skipped non-content request.",
      requestHeaders
    };
  }

  const apiUrl = context.secrets.get("PACKAGE_AGE_GATE_URL");
  const apiToken = context.secrets.get("PACKAGE_AGE_GATE_TOKEN");
  const mode = normalizeMode(context.secrets.get("PACKAGE_AGE_GATE_MODE") || DEFAULT_MODE);

  if (!apiUrl || !apiToken) {
    return {
      status: ActionStatus.STOP,
      message: "Package age gate blocked request: missing PACKAGE_AGE_GATE_URL or PACKAGE_AGE_GATE_TOKEN secret.",
      requestHeaders
    };
  }

  const payload = {
    policy: {
      name: "package-age-gate",
      minimum_age_hours: MINIMUM_PACKAGE_AGE_HOURS
    },
    artifact: {
      repo_key: repoPath.key,
      path: repoPath.path,
      id: repoPath.id,
      name: data?.metadata?.name,
      uri: data?.metadata?.uri
    },
    original_artifact: originalRepoPath
      ? {
          repo_key: originalRepoPath.key,
          path: originalRepoPath.path,
          id: originalRepoPath.id
        }
      : undefined,
    request: {
      client_address: data?.metadata?.clientAddress,
      user_id: data?.userContext?.id,
      user_realm: data?.userContext?.realm,
      is_token: data?.userContext?.isToken,
      head_only: data?.metadata?.headOnly,
      checksum: data?.metadata?.checksum,
      metadata: data?.metadata?.metadata
    },
    worker: {
      event: "BEFORE_REMOTE_DOWNLOAD",
      timestamp: new Date().toISOString()
    }
  };

  try {
    const response = await context.clients.axios.post(apiUrl, payload, {
      timeout: API_TIMEOUT_MS,
      headers: buildHeaders(apiToken)
    });

    const verdict = response?.data || {};
    const decision = safeString(verdict.decision)?.trim().toLowerCase();
    const reason = safeString(verdict.reason) || "No reason returned by package age gate API.";
    const packageLabel = formatPackageLabel(verdict, repoPath);
    const ageHours = verdict.age_hours === undefined ? "unknown" : String(verdict.age_hours);

    if (decision === "allow") {
      requestHeaders["X-Package-Age-Gate"] = { value: ["allow"] };
      return {
        status: ActionStatus.PROCEED,
        message: `Package age gate allowed ${packageLabel}; age_hours=${ageHours}; minimum_age_hours=${MINIMUM_PACKAGE_AGE_HOURS}; reason=${reason}`,
        requestHeaders
      };
    }

    if (decision === "block") {
      requestHeaders["X-Package-Age-Gate"] = { value: [mode === "audit" ? "would-block" : "block"] };

      if (mode === "audit") {
        return {
          status: ActionStatus.WARN,
          message: `AUDIT ONLY: Package age gate would block ${packageLabel}; age_hours=${ageHours}; minimum_age_hours=${MINIMUM_PACKAGE_AGE_HOURS}; reason=${reason}`,
          requestHeaders
        };
      }

      return {
        status: ActionStatus.STOP,
        message: `Package age gate blocked ${packageLabel}; age_hours=${ageHours}; minimum_age_hours=${MINIMUM_PACKAGE_AGE_HOURS}; reason=${reason}`,
        requestHeaders
      };
    }

    requestHeaders["X-Package-Age-Gate"] = { value: ["warn"] };
    return {
      status: ActionStatus.WARN,
      message: `Package age gate warning for ${packageLabel}; decision=${decision || "missing"}; reason=${reason}`,
      requestHeaders
    };
  } catch (error) {
    const err: any = error;
    const errStatus = err?.status || err?.response?.status || "none";
    const errMessage = err?.message || "unknown error";

    requestHeaders["X-Package-Age-Gate"] = { value: [mode === "audit" ? "api-error-audit" : "api-error-block"] };

    if (mode === "audit") {
      return {
        status: ActionStatus.WARN,
        message: `AUDIT ONLY: Package age gate API error. Would fail closed in enforce mode. status=${errStatus}; error=${errMessage}`,
        requestHeaders
      };
    }

    return {
      status: ActionStatus.STOP,
      message: `Package age gate blocked request because policy API failed. status=${errStatus}; error=${errMessage}`,
      requestHeaders
    };
  }
};
