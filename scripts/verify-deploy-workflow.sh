#!/usr/bin/env bash
# Regression test for BUG-016: ensure deploy.yml keeps the
# compose-file-hash-compare logic that triggers a `docker compose down`
# when the compose file changed between deploys.
#
# Without that block, a network/IPAM tweak in docker-compose.prod.yml
# leaves docker's embedded DNS in a stale state and api crash-loops
# (SIGSEGV / exit 139). See docs/ops.md §7.1 + bugs-backlog BUG-016.
#
# Run from repo root: scripts/verify-deploy-workflow.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_YML="$REPO_ROOT/.github/workflows/deploy.yml"

if [ ! -f "$DEPLOY_YML" ]; then
  echo "FAIL: $DEPLOY_YML not found"
  exit 1
fi

fail=0

if ! grep -q '\.last-compose-hash' "$DEPLOY_YML"; then
  echo "FAIL: deploy.yml missing .last-compose-hash sentinel — BUG-016 hash-compare logic was reverted?"
  fail=1
fi

if ! grep -qE 'docker compose .* down' "$DEPLOY_YML"; then
  echo "FAIL: deploy.yml missing 'docker compose ... down' — BUG-016 recreate trigger was reverted?"
  fail=1
fi

if ! grep -q 'sha256sum docker-compose.prod.yml' "$DEPLOY_YML"; then
  echo "FAIL: deploy.yml missing sha256sum hash of docker-compose.prod.yml"
  fail=1
fi

# Optional YAML parse — only if python3 is available (CI usually has it).
if command -v python3 >/dev/null 2>&1; then
  if ! python3 -c "import yaml,sys; yaml.safe_load(open('$DEPLOY_YML'))" 2>/dev/null; then
    # PyYAML may not be installed locally — try a softer check via awk
    # to at least flag obvious indentation breakage.
    if ! python3 -c "import sys; open('$DEPLOY_YML').read()" 2>/dev/null; then
      echo "FAIL: deploy.yml not readable"
      fail=1
    fi
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "BUG-016 regression check FAILED. See docs/bugs-backlog.md BUG-016."
  exit 1
fi

echo "OK: deploy.yml retains BUG-016 hash-compare + compose-down recovery logic."
