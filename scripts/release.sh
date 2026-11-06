#!/usr/bin/env bash
# One command: test, build the panel, deploy the Worker.
# Usage: bash scripts/release.sh
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "" >&2
  echo "RELEASE FAILED at step: $1" >&2
  exit 1
}

step() {
  local name="$1"
  shift
  echo "==> $name"
  "$@" || fail "$name"
}

step "npm ci" npm ci
step "npm test" npm test
step "web: npm ci" npm --prefix web ci
step "web: npm test" npm --prefix web test
step "web: build" npm --prefix web run build

# Check secret names only (never their values).
echo "==> checking secrets (names only)"
secrets_out="$(npx wrangler secret list 2>&1)" || fail "wrangler secret list (are you logged in? run: npx wrangler login)"
missing=()
for s in GITHUB_TOKEN ADMIN_TOKEN MCP_AUTH_TOKEN PANEL_TOKEN; do
  if ! printf '%s' "$secrets_out" | grep -q "\"$s\""; then
    missing+=("$s")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing secrets: ${missing[*]}" >&2
  echo "Set each with: npx wrangler secret put <NAME>" >&2
  fail "secret check"
fi
echo "All required secrets exist."

echo "==> wrangler deploy"
deploy_log="$(mktemp)"
trap 'rm -f "$deploy_log"' EXIT
npx wrangler deploy 2>&1 | tee "$deploy_log" || fail "wrangler deploy"

url="$(grep -Eo 'https://[A-Za-z0-9._-]+\.workers\.dev' "$deploy_log" | head -n 1 || true)"
echo ""
echo "Deployed. Panel path: ${url}/panel/"
