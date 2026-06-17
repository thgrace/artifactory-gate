# artifactory-gate

`artifactory-gate` is a JFrog Artifactory Worker for gating uncached remote package downloads by package version age.

The Worker runs on the Artifactory `Before Remote Download` event. Before Artifactory downloads an uncached package from an upstream remote repository, the Worker resolves the package version's publish time from the public [deps.dev](https://deps.dev) API, computes its age, and gates the download accordingly. Supported ecosystems are npm and PyPI.

deps.dev is unauthenticated and called directly, so the Worker requires no secrets or configuration.

## Policy

- Minimum package version age: `48` hours.
- Package version pinned in `allowlist.json` (exact `system:name@version`): return `ActionStatus.PROCEED` and skip the deps.dev lookup entirely (operational bypass; see [Allowlist](#allowlist)).
- Package age `>= 48h`: return `ActionStatus.PROCEED`.
- Package age `< 48h`: return `ActionStatus.STOP` (blocked).
- deps.dev has no record of the version (`404`, i.e. not yet indexed): fail closed — `ActionStatus.STOP`.
- deps.dev transport error: fail closed — `ActionStatus.STOP`.
- Unsupported ecosystem, unparseable path, or missing `publishedAt`: fail closed — `ActionStatus.STOP` (cannot evaluate the age, so block). Keep the Worker scoped (manifest `repoKeys`) to remotes whose layout it parses, so the unsupported/unparseable branch does not block ecosystems the gate was never meant to cover.
- HEAD / checksum / metadata requests: return `ActionStatus.PROCEED` (skip the deps.dev lookup; the actual content GET is still gated).

Actual blocking with `STOP` on `Before Remote Download` requires the JFrog entitlement that supports Stop Action for this Worker type.

## Allowlist

Some package versions that the gate would block (too young, or not yet indexed) must still be allowed through as an operational exception. `allowlist.json` (repo root) holds those exact pins:

```json
[
  {
    "system": "npm",
    "name": "@scope/pkg",
    "version": "1.2.3",
    "reason": "approved exception — tracked in TICKET-123",
    "addedBy": "6608824+thgrace@users.noreply.github.com"
  }
]
```

`system` is `npm` or `pypi`; `reason` and `addedBy` are documentation-only. Matching is exact `system:name@version`, so future versions stay gated. PyPI names are PEP 503 normalized to match how the Worker derives the name.

Because the Worker is a single import-free file, it cannot read `allowlist.json` at runtime. After editing the JSON, regenerate the inlined copy in both Worker files:

```sh
npm run build:allowlist
```

`node scripts/build-allowlist.mjs --check` (run by `npm test`) fails if a Worker file has drifted from `allowlist.json`. Do not edit the generated block between the `<generated:allowlist>` markers by hand.

### Requesting a bypass (issue-ops feed)

The routine way to add an allowlist entry is to open a GitHub issue, not to edit the JSON directly:

1. Open an issue with the **Allowlist request** form (`system`, `name`, `version`, `reason`). It auto-applies the `allowlist-request` label.
2. Automation (`.github/workflows/allowlist-intake.yml`) validates the request — shape, no duplicate, and that the version exists on deps.dev (HTTP 200). A clean 404 is rejected; a deps.dev outage labels the issue `needs-review` rather than rejecting.
3. On success it appends the entry, regenerates the Worker block, and opens a PR that `Closes` the issue.
4. A CODEOWNERS reviewer merging that PR is the approval gate.
5. The merge triggers `.github/workflows/deploy-worker.yml`, which runs `jf worker deploy` using the `JF_URL` and `JF_ACCESS_TOKEN` repo secrets.

Hand-editing `allowlist.json` + `npm run build:allowlist` remains available as a break-glass path.

## Repository Layout

```text
.
├── README.md
├── allowlist.json
├── scripts
│   ├── build-allowlist.mjs
│   ├── parse-issue.mjs
│   └── apply-allowlist-entry.mjs
├── workers
│   └── package-age-gate.before-remote-download.ts
├── .github
│   ├── CODEOWNERS
│   ├── ISSUE_TEMPLATE
│   │   └── allowlist-request.yml
│   └── workflows
│       ├── allowlist-intake.yml
│       └── deploy-worker.yml
├── docs
│   ├── api-contract.md
│   └── jfrog-setup.md
└── test
    ├── fixtures
    │   └── before-remote-download-event.json
    ├── package-age-gate.test.mjs
    ├── parse-issue.test.mjs
    └── apply-allowlist-entry.test.mjs
```

The runtime Worker source is intentionally a single import-free TypeScript file so it can be pasted into JFrog Workers.

## deps.dev lookup

The Worker derives the ecosystem, package name, and version from the Artifactory `repoPath`, then issues a `GET` to:

```
https://api.deps.dev/v3/systems/{system}/packages/{name}/versions/{version}
```

and reads `publishedAt`. See [docs/api-contract.md](docs/api-contract.md) for the request and response shape the Worker relies on.

## Deploy

See [docs/jfrog-setup.md](docs/jfrog-setup.md) for setup steps.

Manual UI deployment is the simplest path:

1. Create an event-driven Artifactory Worker.
2. Select `Before Remote Download` / `BEFORE_REMOTE_DOWNLOAD`.
3. Scope the filter to the **remote** repository keys — the event fires on the backing remote, so a filter listing only a virtual repo key never matches and the gate never runs.
4. Paste [workers/package-age-gate.before-remote-download.ts](workers/package-age-gate.before-remote-download.ts).
5. Save and enable the Worker (no secrets required).

For a repeatable operator-driven deployment without GitHub Actions or other CI/CD, use the JFrog CLI workflow in [docs/jfrog-setup.md#jfrog-cli-deployment-option](docs/jfrog-setup.md#jfrog-cli-deployment-option).

## Test

The local test harness uses Node's built-in test runner and does not require npm dependencies.

```sh
npm test
```

The tests validate the expected proceed, block, fail-closed (404/transport/no-publishedAt/unsupported/unparseable), missing-metadata, and non-content request behavior.
