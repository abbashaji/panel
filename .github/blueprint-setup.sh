#!/usr/bin/env bash
# Runs inside the work checkout before each acceptance command (trusted copy from main).
# ACCEPT_CMD is the one command this job is about to run. Install only what it needs.
# Anything not recognised below installs everything, so an odd command can never lose a dependency.
set -e
cmd="${ACCEPT_CMD:-}"
root=1; web=1

case "$cmd" in
  *"&&"*|*";"*|*"|"*|*'$('*|*'`'*|*$'\n'*|*"<"*|*">"*) ;;           # chained or compound: install everything
  "npm --prefix web test"|"npm --prefix web run "*) root=0 ;;       # web only
  "dotnet "*|"node --check "*|"bash -n "*) root=0; web=0 ;;        # .NET / syntax checks: no npm packages
  "npm test"|"npx tsc --noEmit"|"node --test "*) web=0 ;;           # Worker tests: web/ is not needed (verified)
esac

# npm ci is exact and fast. A cell that adds a dependency cannot regenerate the lockfile (agents have no
# shell), so when the lockfile is out of sync fall back to npm install and say so in the log.
install() {
  dir="$1"
  if [ "$dir" = "." ]; then ci=(npm ci); inst=(npm install); else ci=(npm --prefix "$dir" ci); inst=(npm --prefix "$dir" install); fi
  if "${ci[@]}" --no-audit --no-fund --prefer-offline; then return 0; fi
  echo "::warning::LOCKFILE OUT OF SYNC in $dir: npm ci failed, falling back to npm install (the owner should regenerate $dir/package-lock.json)"
  "${inst[@]}" --no-audit --no-fund
}

if [ "$root" = 1 ]; then install .; fi
if [ "$web" = 1 ] && [ -f web/package.json ]; then install web; fi
echo "setup: root=$root web=$web for: ${cmd:-<unknown>}"
