# JFrog Setup

This Worker gates uncached package downloads at the Artifactory remote-download boundary. It resolves package version publish times from the public [deps.dev](https://deps.dev) API and blocks versions younger than 48 hours.

The Worker reads no secrets and takes no configuration. deps.dev is unauthenticated and called directly.

## Prerequisites

- JFrog Workers enabled for the Artifactory instance.
- Entitlement support for Stop Action on the `Before Remote Download` event (required for the Worker's `ActionStatus.STOP` to actually block).
- Outbound network access from the Worker runtime to `https://api.deps.dev`.

## Manual UI Deployment

1. Navigate to JFrog Platform Administration > Workers.
2. Create a new event-driven Artifactory Worker.
3. Select event/action: `Before Remote Download` / `BEFORE_REMOTE_DOWNLOAD`.
4. Add filter criteria targeting the **remote** repository keys (e.g. `npm-remote`, `pypi-remote`). `Before Remote Download` fires on the backing remote, not the virtual: when a package is pulled through a virtual repo, the event's `repoPath.key` (and `originalRepoPath.key`) is the remote that resolves the request, not the virtual. A filter scoped only to the virtual repo key never matches, so the gate silently never runs. Scope the filter to the remote repo key(s).
5. Paste the standalone TypeScript source from [../workers/package-age-gate.before-remote-download.ts](../workers/package-age-gate.before-remote-download.ts).
6. Test with the Worker testing pane using [../test/fixtures/before-remote-download-event.json](../test/fixtures/before-remote-download-event.json).
7. Save and enable the Worker.

## JFrog CLI Deployment Option

Use this path when you want a repeatable command-line deployment without GitHub Actions or any other CI/CD system.

JFrog CLI Worker commands operate from a CLI-managed Worker directory. This repository keeps the runtime Worker source in [../workers/package-age-gate.before-remote-download.ts](../workers/package-age-gate.before-remote-download.ts), so the deployment flow is:

1. Configure a JFrog CLI server profile for the target platform.
2. Initialize a local Worker deployment directory.
3. Copy this repository's Worker source into the generated `worker.ts`.
4. Test-run against the fixture payload.
5. Deploy with `jf worker deploy`.

Example:

```sh
mkdir -p .jfrog-worker/package-age-gate
cd .jfrog-worker/package-age-gate

jf worker init BEFORE_REMOTE_DOWNLOAD package-age-gate --server-id <server-id> --force
cp ../../workers/package-age-gate.before-remote-download.ts ./worker.ts

jf worker test-run @../../test/fixtures/before-remote-download-event.json --server-id <server-id>
jf worker deploy --server-id <server-id>
jf worker list --server-id <server-id> --json
```

Review the generated `manifest.json` before deployment. Set the Worker description, enabled state, and `filterCriteria.artifactFilterCriteria.repoKeys`. Scope `repoKeys` to the **remote** repository keys — `Before Remote Download` fires on the backing remote, so a filter listing only a virtual repo key never matches and the gate never runs. Keep environment-specific values out of the public repository.

Every response object the Worker returns must include `requestHeaders` (alongside `status` and `message`); `BeforeRemoteDownloadResponse` requires it, and `jf worker deploy` rejects the source with a type error if any return omits it.

Do not commit deployment manifests from `.jfrog-worker/` unless your organization has explicitly approved that practice. The generated manifest can contain environment-specific configuration.

## Behavior Matrix

| Scenario | deps.dev result | Worker status |
| --- | --- | --- |
| Package pinned in `allowlist.json` | (no call made) | `ActionStatus.PROCEED` |
| Package age is 72 hours | `publishedAt` 72h ago | `ActionStatus.PROCEED` |
| Package age is 12 hours | `publishedAt` 12h ago | `ActionStatus.STOP` |
| Version not yet indexed | `404` | `ActionStatus.STOP` (fail closed) |
| deps.dev unavailable | transport error | `ActionStatus.STOP` (fail closed) |
| Cannot determine publish time | no `publishedAt` | `ActionStatus.STOP` (fail closed) |
| Unsupported ecosystem / unparseable path | (no call made) | `ActionStatus.STOP` (fail closed) |
| HEAD/checksum/metadata request | (no call made) | `ActionStatus.PROCEED` |

## Deployment Checklist

- [ ] Confirm the Artifactory/JFrog plan supports Stop Action for `Before Remote Download`.
- [ ] Confirm `repoKeys` lists the remote repository keys (not just a virtual key) — the event fires on the backing remote, so a virtual-only filter never matches.
- [ ] Confirm the Worker runtime can reach `https://api.deps.dev`.
- [ ] Deploy and enable the Worker.
- [ ] Trigger package manager installs for known new and old packages.
- [ ] Confirm under-48-hour packages are blocked before upstream download/cache.
- [ ] Confirm older packages download and cache normally.
- [ ] Decide whether to add a separate `Before Download` Worker for already-cached artifacts.

## Edge Cases To Validate

- Scoped npm packages such as `@scope/pkg`.
- PyPI wheels and sdists.
- Package manager HEAD requests before GET requests.
- Virtual repositories that resolve to remote repositories. Verified live: pulling a fresh (<48h) npm package through a virtual repo (`appsec-test` → remote `npm-appsec-remote-test`) triggers the Worker with `repoPath.key` set to the remote, and the gate returns `STOP` (the download surfaces as HTTP 404 and the package is never cached). The Worker filter must list the remote key for this to fire.