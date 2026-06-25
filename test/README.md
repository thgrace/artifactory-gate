# Testing

Two layers: an offline unit suite that runs the generated Workers in a sandbox,
and a live containerized test bed that exercises a deployed Worker against a real
JFrog Platform.

## Offline unit suite

Uses Node's built-in test runner; no npm dependencies.

```sh
npm test          # node --test test/*.test.mjs
```

- `npm-age-gate.test.mjs` / `pypi-age-gate.test.mjs` — per-ecosystem behavior:
  proceed, block, fail-closed (404 / transport error / no `publishedAt` /
  unparseable path), missing metadata, and non-content (HEAD / checksum /
  metadata) requests.
- `codegen-drift.test.mjs` — guards that the generated Workers stay in sync with
  the template, the ecosystem fragments, and `allowlist.json`.
- `parse-issue.test.mjs` / `apply-allowlist-entry.test.mjs` — the issue-ops
  allowlist scripts.

`worker-harness.mjs` is the shared (non-test) helper: it reads a generated `.ts`
Worker, strips its TypeScript type annotations by string replacement, and runs it
in a `node:vm` sandbox with mocked `ActionStatus` and `context.clients.axios`.
Its strip rules match exact annotation strings — change a signature in
`workers/src/core.template.ts` or a fragment and you must update the matching
`.replace(...)` calls here or the harness fails at load time.

## Live test bed (`test/docker/`)

A containerized Artifactory **client** that verifies the deployed Workers end to
end — that they block too-young versions and honor the allowlist bypass — by
pulling uncached packages through the test virtual repo (which triggers the
Worker on the backing remote) and asserting the HTTP outcome matches the gate's
expected decision. See [docker/README.md](docker/README.md) for setup and run
instructions.

The live pull path is implemented for **npm** today (`npm-age-gate`); the
PyPI Worker is not yet wired to a test remote. The deploy workflow runs
`test/docker/gate-test.sh suite` as a post-deploy smoke gate for the npm key.

## Sandbox dry-run against the platform

To exercise the Worker source without deploying, use the JFrog CLI sandbox from a
Worker directory:

```sh
cd .jfrog-worker/npm-age-gate
jf worker test-run @./payload.json
```

Edit `payload.json`'s `metadata.repoPath` (and the `headOnly` / `checksum` /
`metadata` flags) to drive each branch of the behavior matrix. See
[../docs/jfrog-setup.md](../docs/jfrog-setup.md) for the full behavior matrix,
deployment steps, and known test package coordinates.
