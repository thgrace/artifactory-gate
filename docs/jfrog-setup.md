# JFrog Setup

This Worker gates uncached package downloads at the Artifactory remote-download boundary.

## Prerequisites

- JFrog Workers enabled for the Artifactory instance.
- Entitlement support for Stop Action on the `Before Remote Download` event if enforcement blocking is required.
- A separately implemented package-age policy API that satisfies [api-contract.md](api-contract.md).

## Manual UI Deployment

1. Navigate to JFrog Platform Administration > Workers.
2. Create a new event-driven Artifactory Worker.
3. Select event/action: `Before Remote Download` / `BEFORE_REMOTE_DOWNLOAD`.
4. Add filter criteria for target remote repositories, such as `npm-remote`, `pypi-remote`, or selected virtual/remote repositories depending on how Artifactory evaluates the event in the environment.
5. Paste the standalone TypeScript source from [../workers/package-age-gate.before-remote-download.ts](../workers/package-age-gate.before-remote-download.ts).
6. Add Worker secrets:
   - `PACKAGE_AGE_GATE_URL`
   - `PACKAGE_AGE_GATE_TOKEN`
   - optional `PACKAGE_AGE_GATE_MODE=audit`
7. Test with the Worker testing pane using [../test/fixtures/before-remote-download-event.json](../test/fixtures/before-remote-download-event.json).
8. Roll out in `audit` mode first.
9. Switch to `enforce` after validating logs and package manager behavior.

## JFrog CLI Deployment Option

Use this path when you want a repeatable command-line deployment without GitHub Actions or any other CI/CD system.

JFrog CLI Worker commands operate from a CLI-managed Worker directory. This repository keeps the runtime Worker source in [../workers/package-age-gate.before-remote-download.ts](../workers/package-age-gate.before-remote-download.ts), so the deployment flow is:

1. Configure a JFrog CLI server profile for the target platform.
2. Initialize a local Worker deployment directory.
3. Copy this repository's Worker source into the generated `worker.ts`.
4. Add Worker secrets locally with `jf worker add-secret`.
5. Test-run against the fixture payload.
6. Deploy with `jf worker deploy`.

Example:

```sh
mkdir -p .jfrog-worker/package-age-gate
cd .jfrog-worker/package-age-gate

jf worker init BEFORE_REMOTE_DOWNLOAD package-age-gate --server-id <server-id> --force
cp ../../workers/package-age-gate.before-remote-download.ts ./worker.ts

jf worker add-secret PACKAGE_AGE_GATE_URL
jf worker add-secret PACKAGE_AGE_GATE_TOKEN
jf worker add-secret PACKAGE_AGE_GATE_MODE

jf worker test-run @../../test/fixtures/before-remote-download-event.json --server-id <server-id>
jf worker deploy --server-id <server-id>
jf worker list --server-id <server-id> --json
```

Review the generated `manifest.json` before deployment. Set the Worker description, enabled state, and repository filters for the target remote or virtual repositories. Keep environment-specific values out of the public repository.

Do not commit encrypted secrets or deployment manifests from `.jfrog-worker/` unless your organization has explicitly approved that practice. The generated manifest can contain environment-specific configuration, and secrets added by `jf worker add-secret` are protected by a master password that is needed for `test-run` and `deploy`.

## Modes

| Mode | Behavior |
| --- | --- |
| `audit` | API `block` decisions return `ActionStatus.WARN` and log that the Worker would have blocked. |
| `enforce` | API `block` decisions return `ActionStatus.STOP`. This is the default. |

## Behavior Matrix

| Scenario | API response | Mode | Worker status |
| --- | --- | --- | --- |
| Package age is 72 hours | `allow` | `enforce` | `ActionStatus.PROCEED` |
| Package age is 12 hours | `block` | `enforce` | `ActionStatus.STOP` |
| Package age is 12 hours | `block` | `audit` | `ActionStatus.WARN` |
| API cannot determine publish time | `warn` | any | `ActionStatus.WARN` |
| API unavailable | error | `enforce` | `ActionStatus.STOP` |
| API unavailable | error | `audit` | `ActionStatus.WARN` |
| HEAD/checksum/metadata request | skipped | any | `ActionStatus.PROCEED` |

## Deployment Checklist

- [ ] Confirm the Artifactory/JFrog plan supports Stop Action for `Before Remote Download`.
- [ ] Confirm target repositories are remote repositories or virtual repositories backed by remote repositories.
- [ ] Deploy the Worker in `audit` mode.
- [ ] Trigger package manager installs for known new and old packages.
- [ ] Verify audit logs show would-block behavior for packages under 48 hours old.
- [ ] Switch `PACKAGE_AGE_GATE_MODE` to `enforce`.
- [ ] Confirm under-48-hour packages are blocked before upstream download/cache.
- [ ] Confirm older packages download and cache normally.
- [ ] Decide whether to add a separate `Before Download` Worker for already-cached artifacts.

## Edge Cases To Validate

- Scoped npm packages such as `@scope/pkg`.
- PyPI wheels and sdists.
- Package manager HEAD requests before GET requests.
- Virtual repositories that resolve to remote repositories.
