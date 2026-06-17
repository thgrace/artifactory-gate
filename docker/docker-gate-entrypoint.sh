#!/usr/bin/env bash
# Wire the JFrog CLI + npm to Vannevar Artifactory from the mounted .env, then
# exec the container command (e.g. gate-test.sh). The configured `jf` client is
# how the test bed pulls packages through the test virtual repo to trigger the
# Before Remote Download Worker. Env arrives via `docker run --env-file .env`:
#   ARTIFACTORY_URL    e.g. https://vannevarlabs.jfrog.io/artifactory
#   ARTIFACTORY_TOKEN  access token
#
# `jf config add` wants the PLATFORM root (no /artifactory suffix); it derives the
# artifactory + xray endpoints itself. So strip a trailing /artifactory.
set -euo pipefail

SERVER_ID="${JF_SERVER_ID:-vannevar}"

if [[ -n "${ARTIFACTORY_TOKEN:-}" && -n "${ARTIFACTORY_URL:-}" ]]; then
    platform_url="${ARTIFACTORY_URL%/}"
    platform_url="${platform_url%/artifactory}"

    # Idempotent: remove any prior config of this id (no-op if absent), re-add.
    jf config remove "$SERVER_ID" --quiet 2>/dev/null || true
    jf config add "$SERVER_ID" \
        --url="$platform_url" \
        --access-token="$ARTIFACTORY_TOKEN" \
        --interactive=false \
        --overwrite >/dev/null
    jf config use "$SERVER_ID" >/dev/null
    echo "[entrypoint] jf configured: server '$SERVER_ID' -> $platform_url" >&2

    # --- package-manager auth so SCA can resolve PRIVATE deps -----------------
    # jf config only auths the `jf` CLI; the actual resolve shells poetry/pip/npm,
    # which need their OWN creds for the Artifactory virtual repos. Wire all three
    # off the same token. Host is the platform host (no scheme).
    host="${platform_url#http*://}"; host="${host%%/*}"
    # Username = token subject's trailing login (sub: jfac@.../users/<login>).
    # Decode the JWT payload with python (always present); fall back to 'token'.
    user="$(ARTIFACTORY_TOKEN="$ARTIFACTORY_TOKEN" python3 - <<'PY'
import os, base64, json
tok = os.environ["ARTIFACTORY_TOKEN"]
try:
    p = tok.split(".")[1]
    p += "=" * (-len(p) % 4)
    sub = json.loads(base64.urlsafe_b64decode(p)).get("sub", "")
    print(sub.rsplit("/users/", 1)[-1] if "/users/" in sub else "token")
except Exception:
    print("token")
PY
)"
    user="${user:-token}"

    # poetry + pip + curl: ~/.netrc (basic auth, token as password).
    umask 077
    printf 'machine %s\n  login %s\n  password %s\n' \
        "$host" "$user" "$ARTIFACTORY_TOKEN" > "$HOME/.netrc"

    # npm: ~/.npmrc, Bearer access token + always-auth for the platform host.
    {
        printf '//%s/artifactory/api/npm/:_authToken=%s\n' "$host" "$ARTIFACTORY_TOKEN"
        printf '//%s/:_authToken=%s\n' "$host" "$ARTIFACTORY_TOKEN"
        printf 'always-auth=true\n'
    } > "$HOME/.npmrc"
    echo "[entrypoint] pkg-manager auth wired (poetry/pip via netrc, npm via npmrc) as '$user'" >&2
else
    echo "[entrypoint] WARN: ARTIFACTORY_URL/ARTIFACTORY_TOKEN unset — jf not configured." >&2
    echo "[entrypoint]       run with: docker run --env-file .env ..." >&2
fi

exec "$@"
