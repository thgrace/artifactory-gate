# artifactory-gate

`artifactory-gate` is a JFrog Artifactory Worker for gating uncached remote package downloads by package version age.

The Worker runs on the Artifactory `Before Remote Download` event. Before Artifactory downloads an uncached package from an upstream remote repository, the Worker calls an external package-age policy API. The policy API owns all ecosystem-specific package metadata resolution.

## Policy

- Minimum package version age: `48` hours.
- API decision `allow`: return `ActionStatus.PROCEED`.
- API decision `block` in `enforce` mode: return `ActionStatus.STOP`.
- API decision `block` in `audit` mode: return `ActionStatus.WARN`.
- API decision `warn` or unknown: return `ActionStatus.WARN`.
- API transport error in `enforce` mode: fail closed with `ActionStatus.STOP`.
- API transport error in `audit` mode: return `ActionStatus.WARN`.

Actual blocking with `STOP` on `Before Remote Download` requires the JFrog entitlement that supports Stop Action for this Worker type.

## Repository Layout

```text
.
├── README.md
├── workers
│   └── package-age-gate.before-remote-download.ts
├── docs
│   ├── api-contract.md
│   └── jfrog-setup.md
└── test
    ├── fixtures
    │   ├── allow-response.json
    │   ├── block-response.json
    │   └── before-remote-download-event.json
    └── package-age-gate.test.mjs
```

The runtime Worker source is intentionally a single import-free TypeScript file so it can be pasted into JFrog Workers.

## Worker Secrets

Configure these secrets in the Worker UI or configuration:

| Secret name | Required | Example | Purpose |
| --- | ---: | --- | --- |
| `PACKAGE_AGE_GATE_URL` | yes | `https://policy.example.com/v1/package-age/verdict` | Placeholder policy API endpoint. |
| `PACKAGE_AGE_GATE_TOKEN` | yes | `REDACTED` | Bearer token sent to the policy API. |
| `PACKAGE_AGE_GATE_MODE` | no | `audit` or `enforce` | Rollout mode. Defaults to `enforce`. |

Use `audit` mode during rollout, then switch to `enforce` after validating logs and package manager behavior.

## Placeholder API

The Worker POSTs JFrog request metadata to `PACKAGE_AGE_GATE_URL`. The API must return one of:

- `allow`
- `block`
- `warn`

The API implementation is intentionally out of scope for this repository. See [docs/api-contract.md](docs/api-contract.md) for the full request and response contract.

## Deploy

See [docs/jfrog-setup.md](docs/jfrog-setup.md) for setup steps.

Manual UI deployment is the simplest path:

1. Create an event-driven Artifactory Worker.
2. Select `Before Remote Download` / `BEFORE_REMOTE_DOWNLOAD`.
3. Paste [workers/package-age-gate.before-remote-download.ts](workers/package-age-gate.before-remote-download.ts).
4. Configure the required secrets.
5. Test in `audit` mode.
6. Switch to `enforce` mode after validation.

For a repeatable operator-driven deployment without GitHub Actions or other CI/CD, use the JFrog CLI workflow in [docs/jfrog-setup.md#jfrog-cli-deployment-option](docs/jfrog-setup.md#jfrog-cli-deployment-option).

## Test

The local test harness uses Node's built-in test runner and does not require npm dependencies.

```sh
npm test
```

The tests validate the expected allow, block, audit, warn, API-error, missing-metadata, and non-content request behavior.
