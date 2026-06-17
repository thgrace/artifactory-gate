# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

`artifactory-gate` is a JFrog Artifactory Worker that gates uncached remote package downloads by package version age. It runs on the Artifactory `Before Remote Download` event. Before Artifactory downloads an uncached package from an upstream remote, the Worker resolves the package version's publish time from the public [deps.dev](https://deps.dev) API, computes its age, and maps the result to an `ActionStatus`.

The Worker calls deps.dev directly. It parses the Artifactory `repoPath` to derive the ecosystem, package name, and version, then issues a `GET` to `https://api.deps.dev/v3/systems/{system}/packages/{name}/versions/{version}` and reads `publishedAt`. deps.dev is unauthenticated, so no API token is required.

Supported ecosystems are **npm and PyPI** (the only path layouts the Worker parses). Any other ecosystem, or a path the Worker cannot parse, fails closed and returns `STOP` (cannot evaluate the age, so block) — so keep the Worker scoped (manifest `repoKeys`) to remotes whose layout it parses. Adding a new ecosystem means adding a path parser plus a deps.dev `system` mapping in the Worker.

## Repository layout

```text
.
├── README.md
├── allowlist.json                                       # source of truth for gate bypasses (ships [])
├── scripts/
│   ├── build-allowlist.mjs                              # codegen: inline allowlist.json into Workers
│   ├── parse-issue.mjs                                  # pure: issue form body -> allowlist entry
│   └── apply-allowlist-entry.mjs                        # pure+CLI: append entry to allowlist.json
├── workers/package-age-gate.before-remote-download.ts   # runtime Worker (single import-free file)
├── deploy/<worker-key>/manifest.json                    # tracked deploy manifests (source of truth for scope)
├── .github/
│   ├── CODEOWNERS                                        # review gate on allowlist.json + workers/
│   ├── ISSUE_TEMPLATE/allowlist-request.yml             # allowlist request issue form
│   └── workflows/
│       ├── allowlist-intake.yml                         # issue -> validate -> auto-PR
│       └── deploy-worker.yml                            # push to main -> jf worker deploy
├── docs/api-contract.md                                 # deps.dev request/response the Worker relies on
├── docs/jfrog-setup.md                                  # deployment + behavior matrix
└── test/
    ├── fixtures/before-remote-download-event.json
    ├── package-age-gate.test.mjs                         # Node built-in test runner (worker)
    ├── parse-issue.test.mjs                              # parser unit tests
    └── apply-allowlist-entry.test.mjs                    # allowlist-append unit tests
```

## Key constraint: the Worker is a single import-free file

`workers/package-age-gate.before-remote-download.ts` must stay a standalone, import-free TypeScript file so it can be pasted directly into the JFrog Workers UI. Do **not** add `import`/`require` or split it into modules. It depends only on JFrog-provided globals: `PlatformContext`, `ActionStatus`, and `context.clients.axios`. The Worker reads no secrets — the deps.dev base URL is a hardcoded constant (`DEPS_DEV_BASE_URL`).

## Policy logic (source of truth: the Worker file)

- Minimum package version age: `48` hours (`MINIMUM_PACKAGE_AGE_HOURS`).
- deps.dev request timeout: `2500` ms (`API_TIMEOUT_MS`).
- The Worker computes `age_hours = now - publishedAt` from the deps.dev version record. `PROCEED` when `age_hours >= 48`, otherwise `STOP`.

Condition → status mapping:

| Condition | Status |
| --- | --- |
| Package in allowlist (exact `system:name@version`) | `PROCEED` (skip deps.dev) |
| `age_hours >= 48` | `PROCEED` |
| `age_hours < 48` | `STOP` |
| deps.dev `404` (version not indexed) | `STOP` (fail closed) |
| deps.dev transport error / non-404 | `STOP` (fail closed) |
| No `publishedAt` in deps.dev response | `STOP` (fail closed) |
| Unsupported ecosystem / unparseable path | `STOP` (fail closed) |
| Missing `repoPath` metadata | `STOP` |
| HEAD / checksum / metadata request | `PROCEED` (skip deps.dev) |

Fail-closed is intentional and must not be weakened to fail-open. A deps.dev `404` is the freshly-published case the gate exists to catch, so an unknown version blocks. The Worker fails closed on every case where it cannot establish the version age — a missing/unparseable `publishedAt`, an unsupported ecosystem, or an unparseable path all return `STOP`. Because the unsupported/unparseable branch blocks, keep the Worker scoped (manifest `repoKeys`) to remotes whose layout it parses, so it does not block ecosystems the gate was never meant to cover. The only non-blocking, non-evaluating returns are the deliberate bypasses (allowlist hit and HEAD/checksum/metadata probes).

## Allowlist (operational bypass)

`allowlist.json` (repo root) is the source of truth for package versions that
bypass the gate entirely. Each entry is an exact pin
(`{ "system", "name", "version", "reason", "addedBy" }`); `reason`/`addedBy` are
documentation-only. The bypass is checked after the path is parsed and before
the deps.dev call — an allowlisted version returns `PROCEED` without an age or
404/transport check. Matching is exact `system:name@version`, so future versions
stay gated. PyPI names are PEP 503 normalized to match the label the Worker
builds from `parsed.name`; npm names are verbatim. Ships empty (`[]`).

Because the Worker stays import-free, the allowlist cannot be read at runtime.
`scripts/build-allowlist.mjs` inlines `allowlist.json` into both Worker files
between `<generated:allowlist>` marker comments. Humans only ever edit the JSON,
then run `npm run build:allowlist`. The generated block is an annotation-free
`new Set([...])`, so `transpileWorkerSource` needs no new `.replace()` rule.
`node scripts/build-allowlist.mjs --check` (run by the test suite) fails if any
Worker file has drifted from `allowlist.json`.

`scripts/build-allowlist.mjs` also exports the shared label/normalization
helpers (`entryLabel`, `normalizePyPiName`, `labelsFromAllowlist`,
`ALLOWLIST_PATH`, `TARGETS`). The issue-ops scripts reuse these so the label and
PEP 503 normalization logic lives in exactly one place — do not duplicate it.

## Issue-ops feed (request → review → deploy)

Routine allowlist requests come in as GitHub issues, not hand edits. The flow:

1. **Request.** A requester opens an issue with the *Allowlist request* form
   (`.github/ISSUE_TEMPLATE/allowlist-request.yml`): a `system` dropdown
   (npm/pypi), `name`, `version`, and a required `reason`. The form auto-applies
   the `allowlist-request` label.
2. **Intake + validate.** `.github/workflows/allowlist-intake.yml` triggers on
   issue `opened`/`edited` carrying that label. It parses the rendered form body
   with `scripts/parse-issue.mjs`, shape-validates, dedupes against
   `allowlist.json`, then checks the version exists on deps.dev
   (`GET /v3/systems/{system}/packages/{name}/versions/{version}`, ~2500ms
   timeout for parity with the Worker). HTTP 200 continues; a clean 404 rejects
   the issue (`invalid` label + comment); a transport error or timeout is treated
   as an outage and labels `needs-review` instead of rejecting (never reject on a
   deps.dev outage).
3. **Auto-PR.** On success the workflow runs `scripts/apply-allowlist-entry.mjs`
   (appends the entry, rejecting duplicates), runs `npm run build:allowlist`,
   commits to branch `allowlist/issue-<number>`, and opens a PR with
   `Closes #<number>`. The workflow uses only the built-in `GITHUB_TOKEN`
   (`contents`/`pull-requests`/`issues: write`); no PAT.
4. **Review.** A CODEOWNERS reviewer (`.github/CODEOWNERS`) reviewing and merging
   the PR is the single human approval gate.
5. **Auto-deploy.** `.github/workflows/deploy-worker.yml` triggers on push to
   `main` touching `workers/**`, `allowlist.json`, or `deploy/**` (plus a
   `workflow_dispatch` for on-demand deploys), runs `npm test` (gate 1),
   configures JFrog CLI from the `JF_URL` and `JF_ACCESS_TOKEN` repo secrets
   (access-token auth), assembles the worker project, runs `jf worker test-run`
   against the fixture (gate 2 — exits non-zero only if the Worker crashes),
   `jf worker deploy`, then a post-deploy live smoke test (gate 3 —
   `docker/gate-test.sh suite`, see below). Because `.jfrog-worker/` is
   gitignored, the job assembles the CLI worker project from the committed Worker
   source + the tracked manifest at `deploy/<worker-key>/manifest.json` (the
   manifest, not `jf worker init`, controls scope/`repoKeys`/`debug`). The worker
   key defaults to `package-age-gate-test`, overridable via the
   `workflow_dispatch` `worker` input or the `WORKER_KEY` repo/org variable.

   Gate 3 runs only when the deployed key is the test Worker
   (`SMOKE_WORKER_KEY`, default `package-age-gate-test`), because the suite
   drives the dedicated npm test repos that only that Worker is scoped to. `jf`
   is already configured by `setup-jfrog-cli`, so the harness runs on the runner
   directly (no container); it pulls uncached packages through the test virtual
   and fails the job if the deployed Worker does not block a fresh version, allow
   an aged one, and honor each npm allowlist entry. Test repo keys are
   overridable via the `GATE_VIRTUAL`/`GATE_REMOTE`/`GATE_CACHE` repo variables.

Pure modules (`parse-issue.mjs`, `apply-allowlist-entry.mjs`) are network-free
and side-effect-isolated so they unit-test directly under `node --test` without
the `node:vm` sandbox; the deps.dev existence check lives in the workflow, not in
the parser. Tests live in `test/parse-issue.test.mjs` and
`test/apply-allowlist-entry.test.mjs`.

Operators can still hand-edit `allowlist.json` + `npm run build:allowlist` for
break-glass cases; the issue-ops feed is the routine path.

## No secrets or configuration

The Worker reads no secrets and takes no configuration. deps.dev is unauthenticated and its base URL is a hardcoded constant (`DEPS_DEV_BASE_URL`). There is no mode toggle — the gate always enforces (`STOP` on a too-young package).

The *deploy workflow* is the one place that needs credentials: it requires the GitHub repo secrets `JF_URL` (JFrog platform base URL) and `JF_ACCESS_TOKEN` (access-token auth) to run `jf worker deploy`. These are CI deploy credentials, not Worker runtime config — the Worker itself still reads nothing.

## Tests

```sh
npm test          # node --test test/*.test.mjs
```

No npm dependencies. The test harness reads the `.ts` Worker, strips its TypeScript type annotations via string replacement (`transpileWorkerSource`), and runs it in a `node:vm` sandbox with mocked `ActionStatus` and `context.clients.axios`.

Important: `transpileWorkerSource` matches **exact** type-annotation strings. If you change a function signature or the default export signature in the Worker, update the matching `.replace(...)` calls in `test/package-age-gate.test.mjs` or the tests break at load time.

## Deployment

The deploy target (Worker key) is **configurable** — it will move from the current test Worker to a real prod Worker later, so nothing hardcodes it. The target defaults to `package-age-gate-test` and is overridable per deploy.

- Each deployable target is a tracked manifest at `deploy/<worker-key>/manifest.json`, whose `name` field is the Worker key. Adding a target = adding a manifest, no workflow edits.
- CI (`workflow_dispatch`) takes a `worker` input defaulting to `package-age-gate-test`; it assembles the CLI dir from `deploy/<worker>/manifest.json` + the tracked `workers/…ts` source, then `jf worker deploy`.
- Manual: `cd .jfrog-worker/<worker-key>/` and run `jf worker deploy`, or pass the key explicitly.

Current state on the platform: only `package-age-gate-test` exists. There is no separate `package-age-gate` prod Worker deployed, and any local `.jfrog-worker/package-age-gate/` is a stale phantom (older policy-API source) — ignore it.

Two paths, both in `docs/jfrog-setup.md`:
- Manual UI: create event-driven Worker → `BEFORE_REMOTE_DOWNLOAD` → paste the Worker source → save and enable. No secrets to set.
- JFrog CLI (`jf worker init/test-run/deploy`), operating from `.jfrog-worker/`. Do not commit generated manifests from `.jfrog-worker/`.

Real `STOP` blocking on `Before Remote Download` requires the JFrog entitlement that supports Stop Action for this Worker type.

## Testing methodology against production

A dedicated test Worker, `package-age-gate-test`, exercises the gate against a live JFrog Platform without touching real remotes. Its project lives in `.jfrog-worker/package-age-gate-test/` (`worker.ts`, `manifest.json`, `payload.json`). The manifest scopes it via `filterCriteria.artifactFilterCriteria.repoKeys` and sets `debug: true`, so its enforcement is contained to the test repos and the sandbox returns debug logs.

`Before Remote Download` fires on the **remote** repo key, not the virtual. The test virtual `appsec-test` is backed by the remote `npm-appsec-remote-test`; when a package is pulled through `appsec-test`, the event's `repoPath.key` is `npm-appsec-remote-test`. So `repoKeys` must include the remote key (`npm-appsec-remote-test`) — a filter scoped only to the virtual `appsec-test` never matches and the gate silently never runs (empty execution history, downloads succeed).

Every Worker return must include `requestHeaders` (alongside `status` and `message`). `BeforeRemoteDownloadResponse` requires it, and `jf worker deploy` rejects the source with a type error if any return omits it. The age gate injects no headers, so each return uses `requestHeaders: {}`.

Run all `jf worker` commands from the test Worker's directory — the worker key and manifest are read from the current directory — or pass the worker key explicitly:

```sh
cd .jfrog-worker/package-age-gate-test
```

1. **Sandbox dry-run (no deploy).** `jf worker test-run @./payload.json` sends the local `worker.ts` to the platform sandbox and runs it against the payload. Edit `payload.json`'s `metadata.repoPath` (and `headOnly`/`checksum`/`metadata` flags) to drive each branch of the behavior matrix — a fresh version for `STOP`, an aged version for `PROCEED`, an unparseable path for a fail-closed `STOP`. Use `@-` to pipe a payload from stdin. With `debug: true` in the manifest, the sandbox returns the Worker's debug logs.

   Known test package versions (so you don't have to rederive them):
   - **`npm:@scope/pkg@1.2.3`** — the version baked into `payload.json` (npm path `@scope/pkg/-/pkg-1.2.3.tgz`). It is fictional, so deps.dev has no record → `404` → fail-closed **`STOP`**. This is the default dry-run case and confirms the fail-closed path end to end.
   - **`@aws-sdk/client-*`** packages are the reliable source for real age-based testing. The whole family republishes roughly hourly at a shared version (e.g. `3.1068.0`), and deps.dev indexes them within minutes — so at any moment there is a genuinely fresh (<48h) version that deps.dev already knows about (an actual age-based `STOP`, not a `404`). There are hundreds of `@aws-sdk/client-*` packages, so an obscure one is almost certainly uncached. Pick a candidate, then confirm two things before pulling:
     - **fresh + indexed:** `curl -s https://api.deps.dev/v3/systems/npm/packages/%40aws-sdk%2Fclient-<x>/versions/<v>` returns a `publishedAt` under 48h old.
     - **uncached:** `jf rt curl /api/storage/npm-appsec-remote-test-cache/@aws-sdk/client-<x>/-/client-<x>-<v>.tgz` returns `404` (else the gate is bypassed — `Before Remote Download` only fires on uncached fetches).
     - **`PROCEED` (aged):** any version published well over 48h ago, e.g. `@aws-sdk/client-s3` from a few days back, still deps.dev-indexed.
     - Avoid `aws-cdk` for the fresh case — deps.dev lags its npm releases by days (latest indexed was `2.1126.0`, published 2026-06-03), so recent versions return `404` (fail-closed `STOP`) rather than an age-based `STOP`.
2. **Deploy.** `jf worker deploy` from the test directory creates or updates `package-age-gate-test` on the platform.
3. **Live trigger.** Pull an uncached package through the `appsec-test` virtual (a real package-manager install or a direct fetch, e.g. `jf rt curl -XGET "/api/npm/appsec-test/@aws-sdk/client-<x>/-/client-<x>-<v>.tgz"`). The download resolves through the backing remote `npm-appsec-remote-test`, which is what triggers the Worker. A version younger than 48h is blocked — the fetch surfaces as HTTP `404` ("Could not find resource") and the package is never written to `npm-appsec-remote-test-cache`. An older version downloads and caches normally. Verified end to end on 2026-06-12 with `@aws-sdk/client-billingconductor@3.1068.0` (age 1.3h → `STOP`).
4. **Inspect runs.** `jf worker execution-history package-age-gate-test --with-test-runs --format table`. Sandbox test runs are excluded by default — `--with-test-runs` includes them. Each entry carries a trace ID for cross-referencing platform logs, plus start/end times, status, trigger, and executed version.

Keep the test Worker scoped to the dedicated test remote (`npm-appsec-remote-test`) and its virtual (`appsec-test`); never widen `repoKeys` to a production remote when validating `STOP` behavior. Note that the remote key must be in `repoKeys` for the gate to fire at all — the constraint is to use a *dedicated test* remote, not to avoid remote keys entirely. Do not commit generated artifacts under `.jfrog-worker/`.

## Planned: exercise scripts (test once deployed)

Additional scripts will be added to this repo to exercise the Worker against a live deployed Artifactory instance — e.g. driving real package-manager installs of known new vs. old packages and asserting the gate blocks the new ones. These are integration/smoke scripts that hit a deployed Worker, distinct from the offline `node:vm` unit tests in `test/`. When adding them, keep environment-specific values (URLs, tokens, repo keys) out of the committed source.

Note: the issue-ops feed scripts under `scripts/` (`parse-issue.mjs`,
`apply-allowlist-entry.mjs`) are *not* these — they manage allowlist intake and
have unit tests in `test/`. The exercise scripts described here are a separate,
still-planned live-trigger harness.

## Conventions

- Keep `README.md`, `docs/`, and the behavior matrix in sync when policy logic changes.
- Convention/spelling: do not introduce `import` statements into the Worker file.
- Code, commits, and PRs: write in normal prose (not caveman).