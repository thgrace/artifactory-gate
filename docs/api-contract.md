# Package Age Gate API Contract

The Worker calls a placeholder policy API before Artifactory downloads an uncached package from an upstream remote repository.

This repository does not implement the API. The API owns all package-ecosystem metadata resolution, including npm, PyPI, Cargo, Maven, or other registry-specific publish-time lookups.

## Endpoint

Configure the endpoint through the Worker secret:

```text
PACKAGE_AGE_GATE_URL
```

The Worker sends an HTTP `POST` request with:

```http
Authorization: Bearer <PACKAGE_AGE_GATE_TOKEN>
Content-Type: application/json
```

The Worker timeout is `2500` ms.

## Request Body

```json
{
  "policy": {
    "name": "package-age-gate",
    "minimum_age_hours": 48
  },
  "artifact": {
    "repo_key": "npm-remote",
    "path": "@scope/pkg/-/pkg-1.2.3.tgz",
    "id": "npm-remote:@scope/pkg/-/pkg-1.2.3.tgz",
    "name": "pkg-1.2.3.tgz",
    "uri": "/artifactory/npm-remote/@scope/pkg/-/pkg-1.2.3.tgz"
  },
  "original_artifact": {
    "repo_key": "npm-virtual",
    "path": "@scope/pkg/-/pkg-1.2.3.tgz",
    "id": "npm-virtual:@scope/pkg/-/pkg-1.2.3.tgz"
  },
  "request": {
    "client_address": "10.0.0.10",
    "user_id": "alice",
    "user_realm": "internal",
    "is_token": true,
    "head_only": false,
    "checksum": false,
    "metadata": false
  },
  "worker": {
    "event": "BEFORE_REMOTE_DOWNLOAD",
    "timestamp": "2026-06-12T15:00:00.000Z"
  }
}
```

## Request Fields

| Field | Description |
| --- | --- |
| `policy.name` | Static policy name, currently `package-age-gate`. |
| `policy.minimum_age_hours` | Minimum accepted package version age. Currently `48`. |
| `artifact` | Resolved remote repository path metadata from Artifactory. |
| `original_artifact` | Original repository path metadata when Artifactory provides it, often from a virtual repository. |
| `request` | Caller and request-shape metadata from the JFrog Worker event. |
| `worker.event` | Static event name, `BEFORE_REMOTE_DOWNLOAD`. |
| `worker.timestamp` | Worker-side timestamp when the policy request was generated. |

The API should use the artifact metadata to identify the package ecosystem, package name, and version. The Worker intentionally does not parse package manager paths.

## Response: Allow

Return `allow` when the package version is at least `minimum_age_hours` old.

```json
{
  "decision": "allow",
  "reason": "Package version is older than the 48 hour minimum age.",
  "ecosystem": "npm",
  "package_name": "@scope/pkg",
  "version": "1.2.3",
  "published_at": "2026-06-09T12:30:00.000Z",
  "age_hours": 74.5,
  "minimum_age_hours": 48,
  "policy_id": "package-age-gate-v1"
}
```

Worker result: `ActionStatus.PROCEED`.

## Response: Block

Return `block` when the package version is younger than `minimum_age_hours`.

```json
{
  "decision": "block",
  "reason": "Package version is only 13.2 hours old.",
  "ecosystem": "npm",
  "package_name": "@scope/pkg",
  "version": "1.2.3",
  "published_at": "2026-06-12T01:48:00.000Z",
  "age_hours": 13.2,
  "minimum_age_hours": 48,
  "policy_id": "package-age-gate-v1"
}
```

Worker result:

- `ActionStatus.STOP` in `enforce` mode.
- `ActionStatus.WARN` in `audit` mode.

## Response: Warn Or Unknown

Return `warn` when the API cannot make a definitive allow/block decision.

```json
{
  "decision": "warn",
  "reason": "Could not determine publish time for this artifact.",
  "minimum_age_hours": 48,
  "policy_id": "package-age-gate-v1"
}
```

Worker result: `ActionStatus.WARN`.

## Transport Errors

API transport failures are not treated the same as an API `warn` decision.

| Mode | Worker result |
| --- | --- |
| `enforce` | `ActionStatus.STOP` |
| `audit` | `ActionStatus.WARN` |

This fail-closed behavior prevents policy bypass when the external policy API is unavailable.
