# jf-gate: live test bed for the package-age-gate Before Remote Download Worker.
# A configured Artifactory client (jf CLI + npm) that triggers the Worker by
# pulling UNCACHED packages through the test virtual repo, then asserts the HTTP
# outcome matches the gate's expected decision (fresh -> blocked, aged ->
# allowed, allowlisted -> allowed). It does NOT run the Worker; the Worker runs
# server-side in Artifactory. This image is only the client that drives it.
#
# Build:  docker build -t jf-gate -f docker/Dockerfile docker
# Run:    docker run --rm --env-file docker/.env -v "$PWD:/work" jf-gate gate-test.sh suite
#
# Token is NOT baked in — it arrives via --env-file at run time (ARTIFACTORY_URL,
# ARTIFACTORY_TOKEN), and the entrypoint wires `jf config add` + npm auth.
FROM python:3.12-slim-bookworm

# Node major version (LTS). Override at build with --build-arg NODE_MAJOR=22.
ARG NODE_MAJOR=20

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1

# Base tooling: git, curl/ca-certs/gnupg (installers), jq (parse deps.dev +
# allowlist.json in the harness), unzip.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates gnupg unzip jq \
    && rm -rf /var/lib/apt/lists/*

# Node + npm via NodeSource. npm lets the harness trigger the gate via a real
# package-manager install, not only a direct tarball GET.
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

# JFrog CLI (`jf`) — official installer drops the binary in /usr/local/bin.
RUN curl -fL https://install-cli.jfrog.io | sh \
    && jf --version

COPY docker-gate-entrypoint.sh /usr/local/bin/docker-gate-entrypoint.sh
COPY gate-test.sh /usr/local/bin/gate-test.sh
RUN chmod +x /usr/local/bin/docker-gate-entrypoint.sh /usr/local/bin/gate-test.sh

WORKDIR /work
ENTRYPOINT ["docker-gate-entrypoint.sh"]
CMD ["bash"]