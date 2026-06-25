#!/usr/bin/env bash
# Live test bed for the package-age-gate Before Remote Download Worker.
#
# Runs INSIDE the jf-gate container (the entrypoint has already pointed `jf` at
# Artifactory). It triggers the Worker by pulling UNCACHED packages through the
# test virtual repo and asserts the observed HTTP outcome matches the gate's
# expected decision. This is an end-to-end check of the deployed Worker — both
# the age block and the allowlist bypass — against a live JFrog Platform.
#
# Decision model (mirrors workers/{npm,pypi}-age-gate.before-remote-download.ts):
#   allowlisted exact system:name@version   -> ALLOW   (skip deps.dev)
#   deps.dev publishedAt age >= 48h          -> ALLOW
#   deps.dev publishedAt age <  48h          -> BLOCK
#   deps.dev 404 (version not indexed)       -> BLOCK   (fail-closed)
#   deps.dev reachable but no publishedAt     -> BLOCK   (fail-closed)
#   deps.dev transport error / non-404        -> BLOCK   (fail-closed)
# Observable at the client:
#   ALLOW -> HTTP 200, artifact written to the cache repo
#   BLOCK -> HTTP 404 ("Could not find resource"), nothing cached
#
# Note: real STOP blocking requires the JFrog entitlement for Stop Action on this
# Worker type. Without it, the gate logs STOP but the download still proceeds —
# a BLOCK case will then surface as ALLOW and FAIL here. That failure is a true
# signal (entitlement missing), not a harness bug.
#
# Usage (from the host):
#   docker run --rm --env-file test/docker/.env -v "$PWD:/work" jf-gate gate-test.sh suite
#   docker run --rm --env-file test/docker/.env -v "$PWD:/work" jf-gate gate-test.sh check npm lodash 4.17.21
#   docker run --rm --env-file test/docker/.env jf-gate gate-test.sh discover-fresh
#
# Mounting the repo at /work lets the suite read allowlist.json for ALLOW cases.
set -uo pipefail

# Repo wiring — GATE_VIRTUAL, GATE_REMOTE, and GATE_CACHE are required config;
# set them in test/docker/.env (or as CI repo Variables). The Before Remote
# Download event fires on the REMOTE key, so the Worker's manifest repoKeys must
# include $REMOTE; the client pulls through the $VIRTUAL.
: "${GATE_VIRTUAL:?set GATE_VIRTUAL (test virtual repo key) in test/docker/.env}"
: "${GATE_REMOTE:?set GATE_REMOTE (test remote repo key) in test/docker/.env}"
: "${GATE_CACHE:?set GATE_CACHE (test cache repo key) in test/docker/.env}"
VIRTUAL="$GATE_VIRTUAL"
REMOTE="$GATE_REMOTE"
CACHE="$GATE_CACHE"
MIN_AGE_HOURS="${GATE_MIN_AGE_HOURS:-48}"
ALLOWLIST="${GATE_ALLOWLIST:-/work/allowlist.json}"
DEPS_DEV="https://api.deps.dev"

PASS=0; FAIL=0

red()   { printf '\033[31m%s\033[0m' "$1"; }
green() { printf '\033[32m%s\033[0m' "$1"; }
dim()   { printf '\033[2m%s\033[0m' "$1"; }

# --- helpers ----------------------------------------------------------------

# PEP 503 name normalization (npm names stay verbatim).
norm_pypi() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[-_.]+/-/g'; }

# URL-encode an npm/pypi package name for a deps.dev path (@ and / only).
enc_name() { printf '%s' "$1" | sed -e 's/@/%40/g' -e 's:/:%2F:g'; }

# npm remote artifact path: [@scope/]name/-/<unscoped>-<version>.tgz
npm_path() {
  local name="$1" version="$2" unscoped
  unscoped="${name##*/}"
  printf '%s/-/%s-%s.tgz' "$name" "$unscoped" "$version"
}

# Is system:name@version in allowlist.json? (npm verbatim, pypi PEP 503).
in_allowlist() {
  local system="$1" name="$2" version="$3"
  [ -f "$ALLOWLIST" ] || return 1
  local filter
  if [ "$system" = "pypi" ]; then
    filter='any(.[]; (.system|ascii_downcase)==$s and (.name|ascii_downcase|gsub("[-_.]+";"-"))==$n and (.version|tostring)==$v)'
    name="$(norm_pypi "$name")"
  else
    filter='any(.[]; (.system|ascii_downcase)==$s and .name==$n and (.version|tostring)==$v)'
  fi
  jq -e --arg s "$system" --arg n "$name" --arg v "$version" "$filter" "$ALLOWLIST" >/dev/null 2>&1
}

# Echo the expected decision: "ALLOW <reason>" or "BLOCK <reason>".
expected_decision() {
  local system="$1" name="$2" version="$3"
  if in_allowlist "$system" "$name" "$version"; then
    echo "ALLOW allowlisted"; return
  fi
  local url resp code body published age
  url="$DEPS_DEV/v3/systems/$system/packages/$(enc_name "$name")/versions/$version"
  resp="$(curl -s -m 5 -w $'\n%{http_code}' "$url")"
  code="${resp##*$'\n'}"; body="${resp%$'\n'*}"
  if [ "$code" = "404" ]; then
    echo "BLOCK deps.dev-404-fail-closed"; return
  fi
  if [ "$code" != "200" ]; then
    echo "BLOCK deps.dev-error-$code-fail-closed"; return
  fi
  published="$(printf '%s' "$body" | jq -r '.publishedAt // empty')"
  if [ -z "$published" ]; then
    # Worker fails closed (STOP) when it cannot establish the age.
    echo "BLOCK no-publishedAt-fail-closed"; return
  fi
  age="$(awk -v now="$(date -u +%s)" -v pub="$(date -u -d "$published" +%s)" \
        'BEGIN { printf "%.1f", (now-pub)/3600 }')"
  if awk -v a="$age" -v m="$MIN_AGE_HOURS" 'BEGIN { exit !(a>=m) }'; then
    echo "ALLOW age=${age}h"
  else
    echo "BLOCK age=${age}h"
  fi
}

# HTTP code for a path via the configured jf client. $1=method $2=path
jf_code() { jf rt curl -s -o /dev/null -w '%{http_code}' -X "$1" "$2" 2>/dev/null; }

# --- one case ---------------------------------------------------------------

check() {
  local system="$1" name="$2" version="$3"
  local label="$system:$name@$version"
  printf '\n— %s\n' "$label"

  if [ "$system" != "npm" ]; then
    echo "  $(red SKIP): live pull implemented for npm only (no pypi test repo wired)."
    return
  fi

  local decision expected reason
  decision="$(expected_decision "$system" "$name" "$version")"
  expected="${decision%% *}"; reason="${decision#* }"
  echo "  expected: $expected  $(dim "($reason)")"

  local path; path="$(npm_path "$name" "$version")"

  # Evict from cache so Before Remote Download fires (it only runs on uncached
  # fetches). Ignore failures — a clean cache is the common case.
  jf_code DELETE "/$CACHE/$path" >/dev/null

  local code; code="$(jf_code GET "/api/npm/$VIRTUAL/$path")"
  local cache_code; cache_code="$(jf_code GET "/api/storage/$CACHE/$path")"
  local cached="no"; [ "$cache_code" = "200" ] && cached="yes"
  echo "  observed: HTTP $code  cached=$cached  $(dim "(pull /api/npm/$VIRTUAL/$path)")"

  local actual="?"
  if [ "$code" = "200" ] && [ "$cached" = "yes" ]; then actual="ALLOW"
  elif [ "$code" = "404" ] && [ "$cached" = "no" ]; then actual="BLOCK"
  fi

  if [ "$actual" = "$expected" ]; then
    echo "  $(green PASS): gate decision $actual matches."
    PASS=$((PASS+1))
  else
    echo "  $(red FAIL): expected $expected, observed $actual (HTTP $code, cached=$cached)."
    FAIL=$((FAIL+1))
  fi
}

# --- discover a currently-fresh, indexed, uncached npm version --------------
# The @aws-sdk/client-* family republishes ~hourly at a shared version and
# deps.dev indexes it within minutes, so an obscure one is almost always a fresh
# (<48h) version deps.dev already knows — an age-based STOP, not a 404.
discover_fresh() {
  local candidates=(
    client-billingconductor client-mwaa client-iot-roborunner
    client-migrationhubstrategy client-codeguru-security client-kinesis-video-signaling
    client-pca-connector-ad client-chime-sdk-media-pipelines client-internetmonitor
    client-oam client-osis client-tnb client-vpc-lattice client-workspaces-thin-client
  )
  local x name enc pkg version published age cache_code
  for x in "${candidates[@]}"; do
    name="@aws-sdk/$x"; enc="$(enc_name "$name")"
    pkg="$(curl -s -m 5 "$DEPS_DEV/v3/systems/npm/packages/$enc")"
    [ -n "$pkg" ] || continue
    read -r version published < <(printf '%s' "$pkg" | jq -r '
      [.versions[]? | select(.publishedAt != null)]
      | sort_by(.publishedAt) | last
      | "\(.versionKey.version // "") \(.publishedAt // "")"' 2>/dev/null)
    [ -n "$version" ] && [ -n "$published" ] || continue
    age="$(awk -v now="$(date -u +%s)" -v pub="$(date -u -d "$published" +%s)" \
          'BEGIN { printf "%.1f", (now-pub)/3600 }')"
    awk -v a="$age" -v m="$MIN_AGE_HOURS" 'BEGIN { exit !(a<m) }' || continue
    # Must be uncached or the gate is bypassed.
    cache_code="$(jf_code GET "/api/storage/$CACHE/$(npm_path "$name" "$version")")"
    [ "$cache_code" = "200" ] && continue
    printf '%s %s %s\n' npm "$name" "$version"
    return 0
  done
  return 1
}

# --- suite ------------------------------------------------------------------

suite() {
  echo "Repo wiring: virtual=$VIRTUAL remote=$REMOTE cache=$CACHE min_age=${MIN_AGE_HOURS}h"

  # 1. Aged package -> ALLOW. Stable, long-published, deps.dev-indexed.
  check npm lodash 4.17.21

  # 2. Fresh package -> BLOCK (age-based). Discovered live.
  local fresh
  if fresh="$(discover_fresh)"; then
    # shellcheck disable=SC2086
    check $fresh
  else
    echo; echo "  $(red SKIP): no fresh+indexed+uncached @aws-sdk/client-* found right now."
    echo "  Retry shortly, or pass one explicitly: gate-test.sh check npm @aws-sdk/client-<x> <v>"
  fi

  # 3. Allowlist bypass -> ALLOW for every npm entry in allowlist.json.
  if [ -f "$ALLOWLIST" ] && [ "$(jq '[.[] | select(.system=="npm")] | length' "$ALLOWLIST" 2>/dev/null)" -gt 0 ] 2>/dev/null; then
    while read -r n v; do
      check npm "$n" "$v"
    done < <(jq -r '.[] | select(.system=="npm") | "\(.name) \(.version)"' "$ALLOWLIST")
  else
    echo; echo "  $(dim 'allowlist note'): no npm entries in $ALLOWLIST (ships []), so no bypass case ran."
    echo "  To exercise it: add a FRESH version to allowlist.json, run npm run build:allowlist,"
    echo "  redeploy the Worker, then re-run — that coordinate should flip BLOCK -> ALLOW."
  fi

  echo; printf 'RESULT: %s passed, %s failed\n' "$(green "$PASS")" "$([ "$FAIL" -gt 0 ] && red "$FAIL" || printf '%s' "$FAIL")"
  [ "$FAIL" -eq 0 ]
}

# --- dispatch ---------------------------------------------------------------

cmd="${1:-suite}"; shift || true
case "$cmd" in
  suite)          suite ;;
  check)          [ "$#" -eq 3 ] || { echo "usage: gate-test.sh check <system> <name> <version>" >&2; exit 2; }
                  check "$1" "$2" "$3"
                  echo; printf 'RESULT: %s passed, %s failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ] ;;
  discover-fresh) discover_fresh || { echo "no fresh candidate found right now" >&2; exit 1; } ;;
  *)              echo "usage: gate-test.sh {suite|check <system> <name> <version>|discover-fresh}" >&2; exit 2 ;;
esac
