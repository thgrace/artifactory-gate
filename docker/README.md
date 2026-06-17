# jf-audit container

One image, both toolchains — **python3.12 + poetry** and **node20 + npm** — with
the JFrog CLI (`jf`) preconfigured against Vannevar Artifactory. Makes
`jf audit` (Xray SCA + JAS) easy to run for either ecosystem without polluting
your host.

Why both in one image: SCA shells the ecosystem's own resolver (`poetry install`
for Python, `npm install`/lockfile for npm), so the right toolchain must be
present. Python base means system python is 3.12 — sidesteps the Poetry-on-3.9
silent-skip gotcha for 3.12 targets (see `audit_repo.py`).

## Build

```bash
docker build -t jf-audit -f docker/Dockerfile docker
# Node 22 instead of 20:
docker build -t jf-audit --build-arg NODE_MAJOR=22 -f docker/Dockerfile docker
```

## Run

Token is never baked in — it comes from the repo `.env` at run time
(`ARTIFACTORY_URL`, `ARTIFACTORY_TOKEN`). The entrypoint runs `jf config add`.

```bash
# interactive shell, repo mounted at /work
docker run --rm -it --env-file .env -v "$PWD/repos/myapp:/work" jf-audit

# one-shot SCA scan
docker run --rm --env-file .env -v "$PWD/repos/myapp:/work" jf-audit \
    jf audit --format=json --sca=true

# JAS (sarif) pass
docker run --rm --env-file .env -v "$PWD/repos/myapp:/work" jf-audit \
    jf audit --format=sarif
```

For a Poetry target needing a non-3.12 interpreter, install that python in the
image (add to the Dockerfile) or scan the matching subdir — same constraint
`audit_repo.py` documents.

## Notes

- `ARTIFACTORY_URL` keeps its `/artifactory` suffix in `.env`; the entrypoint
  strips it to get the platform root that `jf config add --url` expects.
- Server id defaults to `vannevar`; override with `-e JF_SERVER_ID=...`.
