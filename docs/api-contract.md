# deps.dev Lookup Contract

Before Artifactory downloads an uncached package from an upstream remote, the Worker resolves the package version's publish time from the public [deps.dev](https://deps.dev) API and computes its age.

The Worker calls deps.dev directly. There is no separate policy API and no configuration: deps.dev is unauthenticated, and its base URL is a hardcoded constant (`DEPS_DEV_BASE_URL = https://api.deps.dev`) in the Worker.

## Deriving the request

The Worker parses the Artifactory `repoPath` to derive three values:

| Value | Source |
| --- | --- |
| `system` | The repo key. `npm` if the key contains `npm`; `pypi` if it contains `pypi` or `pip`. Any other key is an unsupported ecosystem. |
| `name` | Parsed from the artifact path. npm: `[@scope/]name/-/...`. PyPI: the package name segment of the wheel/sdist filename (PEP 503 normalized). |
| `version` | Parsed from the artifact path filename. |

If the ecosystem is unsupported or the path cannot be parsed, the Worker fails closed and returns `ActionStatus.STOP` without calling deps.dev. Keep the Worker scoped (manifest `repoKeys`) to remotes whose layout it parses, so this branch does not block ecosystems the gate was never meant to cover.

## Request

```http
GET https://api.deps.dev/v3/systems/{system}/packages/{name}/versions/{version}
```

`{name}` and `{version}` are URL-encoded. No headers are required. `API_TIMEOUT_MS` (`2500` ms) is the *intended* request deadline, but the JFrog Workers sandbox rejects the axios `timeout` option and exposes no `AbortController`/`setTimeout`, and the manifest has no execution-duration field — so no client-side deadline is actually applied. A hung request is bounded only by the platform-internal worker execution limit.

Example:

```http
GET https://api.deps.dev/v3/systems/npm/packages/%40scope%2Fpkg/versions/1.2.3
```

## Response

The Worker reads a single field from the deps.dev version record:

```json
{
  "publishedAt": "2026-06-09T12:30:00Z"
}
```

| Field | Used for |
| --- | --- |
| `publishedAt` | RFC 3339 publish timestamp. The Worker computes `age_hours = (now - publishedAt) / 3600000`. |

deps.dev returns additional fields; the Worker ignores them.

## Worker response shape

Every value the Worker returns is a `BeforeRemoteDownloadResponse`, which requires three fields — `status`, `message`, and `requestHeaders`:

```ts
{
  status: ActionStatus,            // PROCEED | STOP | WARN
  message: string,                 // human-readable reason, logged by the platform
  requestHeaders: { [k: string]: { value: string[] } }  // headers to inject on the upstream request
}
```

The age gate never injects headers, so it returns `requestHeaders: {}` on every path. The field is non-optional: `jf worker deploy` fails type validation if any return omits it.

## Outcomes

| deps.dev result | Worker status |
| --- | --- |
| `publishedAt` present, `age_hours >= 48` | `ActionStatus.PROCEED` |
| `publishedAt` present, `age_hours < 48` | `ActionStatus.STOP` (blocked) |
| `publishedAt` missing / unparseable | `ActionStatus.STOP` (fail closed) |
| `404` (version not indexed yet) | `ActionStatus.STOP` (fail closed) |
| Any other transport error | `ActionStatus.STOP` (fail closed) |

A `404` is treated as a block, not a warning: an unindexed version is the freshly-published case the gate exists to catch. Fail-closed behavior prevents policy bypass when deps.dev is unavailable.