#!/usr/bin/env bash
# Regenerate apps/api/openapi.json from a live API boot.
#
# The script assumes `docker compose up -d` has been run at least once
# so the api container is reachable via Caddy on http://localhost. When
# the container is already up it shortcuts into a single `curl`; when
# it isn't, it boots the stack (minus the web + caddy proxy) long enough
# to snapshot the OpenAPI document.
#
# Run either directly (`./scripts/export-openapi.sh`) or via the root
# pnpm alias (`pnpm api:openapi`). Depends on curl + jq + docker.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/apps/api/openapi.json"
SWAGGER_URL="${OPENAPI_SWAGGER_URL:-http://localhost/api/swagger/v1/swagger.json}"

echo "▶ Probing $SWAGGER_URL …"

already_up=true
if ! curl -fsS "$SWAGGER_URL" >/dev/null 2>&1; then
  already_up=false
  echo "  not reachable — starting docker compose stack"
  (cd "$ROOT" && docker compose up -d postgres redis seaweedfs api caddy >/dev/null)

  # Wait up to 60s for the API to answer.
  for _ in $(seq 1 60); do
    if curl -fsS "$SWAGGER_URL" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -fsS "$SWAGGER_URL" >/dev/null 2>&1; then
    echo "✗ API did not expose Swagger within 60s." >&2
    exit 1
  fi
fi

echo "▶ Fetching OpenAPI document …"
curl -fsS "$SWAGGER_URL" | python3 -m json.tool --no-ensure-ascii > "$OUT"

echo "✓ Wrote $OUT ($(wc -c < "$OUT") bytes)"

if [[ "$already_up" == false ]]; then
  echo "▶ Tearing down compose stack …"
  (cd "$ROOT" && docker compose down >/dev/null)
fi
