# JFrog Setup

These Workers gate uncached package downloads at the Artifactory remote-download boundary. They resolve package version publish times from the public [deps.dev](https://deps.dev) API and block versions younger than 48 hours. There is one Worker per ecosystem — `npm-age-gate` and `pypi-age-gate` — each handling exactly one ecosystem.

The Workers read no secrets and take no configuration. deps.dev is unauthenticated and called directly.

## Prerequisites

- JFrog Workers enabled for the Artifactory instance.
- Entitlement support for Stop Action on the `Before Remote Download` event (required for the Worker's `ActionStatus.STOP` to actually block).
- Outbound network access from the Worker runtime to `https://api.deps.dev`.

## Manual UI Deployment

1. Navigate to JFrog Platform Administration > Workers.
2. Create a new event-driven Artifactory Worker.
3. Select event/action: `Before Remote Download` / `BEFORE_REMOTE_DOWNLOAD`. Create one Worker per ecosystem (npm, PyPI).
4. Add filter criteria targeting the **remote** repository keys (e.g. `npm-remote`, `pypi-remote`). `Before Remote Download` fires on the backing remote, not the virtual: when a package is pulled through a virtual repo, the event's `repoPath.key` (and `originalRepoPath.key`) is the remote that resolves the request, not the virtual. A filter scoped only to the virtual repo key never matches, so the gate silently never runs. Scope the filter to the remote repo key(s).
5. Paste the standalone (generated) TypeScript source for the ecosystem: [../workers/npm-age-gate.before-remote-download.ts](../workers/npm-age-gate.before-remote-download.ts) or [../workers/pypi-age-gate.before-remote-download.ts](../workers/pypi-age-gate.before-remote-download.ts). These are generated from `workers/src/`; do not hand-edit them.
6. Test with the Worker testing pane using [../test/fixtures/before-remote-download-event.json](../test/fixtures/before-remote-download-event.json).
7. Save and enable the Worker.

## JFrog CLI Deployment Option

Use this path when you want a repeatable command-line deployment without GitHub Actions or any other CI/CD system.

JFrog CLI Worker commands operate from a CLI-managed Worker directory. This repository keeps the generated Worker sources in [../workers/npm-age-gate.before-remote-download.ts](../workers/npm-age-gate.before-remote-download.ts) and [../workers/pypi-age-gate.before-remote-download.ts](../workers/pypi-age-gate.before-remote-download.ts), and tracks a deploy manifest per Worker key at `deploy/<worker-key>/manifest.json` (the manifest, not `jf worker init`, is the source of truth for scope/`repoKeys`/`debug`). The Worker source is derived from the key prefix: `<eco>-age-gate*` → `workers/<eco>-age-gate.before-remote-download.ts`. The production Worker keys are `npm-age-gate` and `pypi-age-gate`. The deployment flow per key is:

1. Configure a JFrog CLI server profile for the target platform.
2. Assemble a local Worker deployment directory from the tracked manifest + the prefix-derived Worker source.
3. Test-run against the fixture payload.
4. Deploy with `jf worker deploy`.

Example (npm Worker):

```sh
mkdir -p .jfrog-worker/npm-age-gate
cd .jfrog-worker/npm-age-gate

cp ../../workers/npm-age-gate.before-remote-download.ts ./worker.ts
cp ../../deploy/npm-age-gate/manifest.json ./manifest.json

jf worker test-run @../../test/fixtures/before-remote-download-event.json --server-id <server-id>
jf worker deploy --server-id <server-id>
jf worker list --server-id <server-id> --json
```

Review the tracked `manifest.json` before deployment. It carries the Worker description, enabled state, and `filterCriteria.artifactFilterCriteria.repoKeys`. The committed manifests carry placeholder `repoKeys` (`["<virtual-key>", "<remote-key>"]`); CI injects the real values from the `<KEY>_REPO_KEYS` repo Variable at deploy time (e.g. `NPM_AGE_GATE_REPO_KEYS` for `npm-age-gate`). For a manual deploy, patch the `repoKeys` in the assembled manifest before running `jf worker deploy`. Scope `repoKeys` to the **remote** repository keys — `Before Remote Download` fires on the backing remote, so a filter listing only a virtual repo key never matches and the gate never runs. The `pypi-age-gate` manifest's `repoKeys` are a placeholder TODO (no PyPI repo is wired yet) — confirm the real virtual + remote keys before its first deploy.

Every response object a Worker returns must include `requestHeaders` (alongside `status` and `message`); `BeforeRemoteDownloadResponse` requires it, and `jf worker deploy` rejects the source with a type error if any return omits it.

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
| Unparseable path (does not match the Worker's ecosystem layout) | (no call made) | `ActionStatus.STOP` (fail closed) |
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
- Virtual repositories that resolve to remote repositories. Verified live: pulling a fresh (<48h) npm package through a virtual repo (e.g. `npm-virtual` → remote `npm-remote`) triggers the Worker with `repoPath.key` set to the remote, and the gate returns `STOP` (the download surfaces as HTTP 404 and the package is never cached). The Worker filter must list the remote key for this to fire.