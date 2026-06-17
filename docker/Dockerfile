# jf-audit: one image, both toolchains (python3.12 + poetry, node20 + npm) plus
# the JFrog CLI, preconfigured against Vannevar Artifactory at runtime.
#
# Build:  docker build -t jf-audit -f docker/Dockerfile docker
# Run:    docker run --rm -it --env-file .env -v "$PWD/repos/myapp:/work" jf-audit
#         then inside:  jf audit --format=json --sca=true
#
# Token is NOT baked in — it arrives via --env-file at run time (ARTIFACTORY_URL,
# ARTIFACTORY_TOKEN), and the entrypoint wires `jf config add`.
FROM python:3.12-slim-bookworm

# Node major version (LTS). Override at build with --build-arg NODE_MAJOR=22.
ARG NODE_MAJOR=20

ENV DEBIAN_FRONTEND=noninteractive \
    POETRY_NO_INTERACTION=1 \
    PIP_NO_CACHE_DIR=1

# Base tooling: git (clone targets), curl/ca-certs/gnupg (installers).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates gnupg unzip \
    && rm -rf /var/lib/apt/lists/*

# Node + npm via NodeSource.
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

# Poetry (system-wide). pipx-style isolated install via pip into /usr/local.
RUN pip install --no-cache-dir poetry \
    && poetry --version

# JFrog CLI (`jf`) — official installer drops the binary in /usr/local/bin.
RUN curl -fL https://install-cli.jfrog.io | sh \
    && jf --version

COPY docker-audit-entrypoint.sh /usr/local/bin/docker-audit-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-audit-entrypoint.sh

WORKDIR /work
ENTRYPOINT ["docker-audit-entrypoint.sh"]
CMD ["bash"]
