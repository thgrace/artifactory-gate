# jf-gate test bed

A containerized Artifactory **client** for verifying the deployed
`package-age-gate` Before Remote Download Worker end to end — that it **blocks**
too-young package versions and that the **allowlist** bypass works.

The Worker runs server-side in Artifactory; this image does not run it. The
container only pulls uncached packages through the test virtual repo (which
triggers the Worker on the backing remote) and asserts the HTTP result matches
the gate's expected decision.

## How it works

`gate-test.sh` mirrors the Worker's decision logic locally to compute an
expected outcome, then pulls and observes the actual one:

| Decision (from deps.dev + `allowlist.json`) | Client observes |
| --- | --- |
| allowlisted exact `system:name@version` | `ALLOW` → HTTP 200, written to cache |
| deps.dev age ≥ 48h | `ALLOW` → HTTP 200, written to cache |
| deps.dev age < 48h | `BLOCK` → HTTP 404, nothing cached |
| deps.dev 404 (not indexed) | `BLOCK` → HTTP 404, nothing cached |

Before each pull it deletes the artifact from the cache repo — `Before Remote
Download` only fires on an **uncached** fetch, so an already-cached package would
bypass the gate.

> Real `STOP` blocking requires the JFrog entitlement for Stop Action on this
> Worker type. Without it the Worker logs `STOP` but the download still
> proceeds, so a `BLOCK` case surfaces as `ALLOW` and the harness reports
> `FAIL` — a true signal that the entitlement is missing, not a harness bug.

## Setup

```bash
cp docker/.env.example docker/.env   # then fill in ARTIFACTORY_TOKEN
docker build -t jf-gate -f docker/Dockerfile docker
```

The token is never baked into the image; it arrives via `--env-file` at run
time, and the entrypoint wires `jf config add` + npm auth.

## Run

Mount the repo at `/work` so the suite can read `allowlist.json`:

```bash
# full behavior matrix: aged ALLOW, fresh BLOCK, plus an ALLOW per allowlist entry
docker run --rm --env-file docker/.env -v "$PWD:/work" jf-gate gate-test.sh suite

# one ad-hoc coordinate (expected decision computed from deps.dev + allowlist)
docker run --rm --env-file docker/.env -v "$PWD:/work" jf-gate gate-test.sh check npm lodash 4.17.21

# print a currently fresh+indexed+uncached @aws-sdk/client-* coordinate
docker run --rm --env-file docker/.env jf-gate gate-test.sh discover-fresh
```

`suite` exits non-zero if any case fails, so it works as a CI/smoke gate.

## Verifying the allowlist bypass

The allowlist ships empty, so `suite` has no bypass case until you add one. To
prove the bypass flips a decision:

1. `gate-test.sh discover-fresh` → a fresh (`BLOCK`) npm coordinate.
2. `gate-test.sh check npm <name> <version>` → confirms `BLOCK`.
3. Add that exact pin to `allowlist.json`, run `npm run build:allowlist`, and
   redeploy the Worker.
4. Re-run step 2 → it should now report `ALLOW` (`allowlisted`).

## Scope / ecosystems

The live pull path is implemented for **npm** (the only test repo wired:
remote `npm-appsec-remote-test`, virtual `appsec-test`). The gate also supports
PyPI; testing it the same way needs a dedicated PyPI test remote + virtual and
the matching `GATE_*` overrides. `check pypi ...` currently computes the
expected decision but skips the pull.

## Notes

- `ARTIFACTORY_URL` keeps its `/artifactory` suffix in `.env`; the entrypoint
  strips it to the platform root `jf config add --url` expects.
- Repo keys and the 48h threshold are overridable via `GATE_*` env (see
  `.env.example`); defaults match the dedicated test repos in `CLAUDE.md`.
- `docker/.env` is gitignored — never commit the token.