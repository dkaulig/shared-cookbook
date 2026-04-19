#!/usr/bin/env bash
# Familien-Kochbuch live smoke test (OPS1).
#
# Post-deploy verification that hits the real production API via HTTPS as
# the orchestrator bot and walks the happy-path end-to-end:
#
#   1. Health          — GET  /api/health
#   2. Login           — POST /api/auth/login                          (bot)
#   3. Create group    — POST /api/groups
#   4. Create recipe   — POST /api/groups/{groupId}/recipes
#   5. Rate recipe     — POST /api/recipes/{recipeId}/ratings    (5 ★)
#   6. Fetch recipe    — GET  /api/recipes/{recipeId}/ratings  (avg ≈ 5)
#   7. Cook marker     — POST /api/recipes/{recipeId}/cook
#   8. Cleanup         — DELETE recipe + group (best-effort)
#
# Exits 0 on full green; non-zero with a clear step-number error on failure.
# Cleanup on steps 1-7 pass is guaranteed; on failure we still *try* to
# clean up whatever we managed to create before bailing.
#
# Env vars:
#   SMOKE_BASE_URL       default https://EXAMPLE_HOST
#   SMOKE_BOT_EMAIL      default orchestrator@EXAMPLE_HOST
#   SMOKE_BOT_PASSWORD   REQUIRED — no default; never hardcoded.
#
# Requires: bash, curl, jq.

set -euo pipefail

command -v jq >/dev/null || { echo "jq required" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl required" >&2; exit 2; }

BASE_URL="${SMOKE_BASE_URL:-https://EXAMPLE_HOST}"
BOT_EMAIL="${SMOKE_BOT_EMAIL:-orchestrator@EXAMPLE_HOST}"
BOT_PASSWORD="${SMOKE_BOT_PASSWORD:-}"

TOTAL_STEPS=8
EPOCH="$(date +%s)"
GROUP_NAME="Smoke-Test-Group-${EPOCH}"
RECIPE_TITLE="Smoke-Test-Recipe-${EPOCH}"

# Populated as the flow progresses — used by the trap-driven cleanup on
# early failure so we never leak a half-built group/recipe into prod.
TOKEN=""
GROUP_ID=""
RECIPE_ID=""

info() { printf '▶ Step %d/%d: %s…\n' "$1" "$TOTAL_STEPS" "$2"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }

# Emit a final status bar + exit non-zero, including the failing step
# number and a short reason.  Never echoes the password.
fail_step() {
  local step="$1"; shift
  printf '\n✗ SMOKE FAILED at step %d: %s\n' "$step" "$*" >&2
  exit 1
}

[[ -n "$BOT_PASSWORD" ]] || {
  printf '✗ SMOKE_BOT_PASSWORD is not set. Refusing to run.\n' >&2
  printf '  Export it from the locally-cached .env (see docs/ops.md §2 + §6).\n' >&2
  exit 2
}

# Best-effort cleanup if the script exits early — swallows errors so a
# double-failure (impl bug + cleanup 404) surfaces the original failure.
cleanup_on_exit() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    if [[ -n "$RECIPE_ID" && -n "$TOKEN" ]]; then
      curl -sS -o /dev/null -X DELETE \
        -H "Authorization: Bearer $TOKEN" \
        "${BASE_URL}/api/recipes/${RECIPE_ID}" 2>/dev/null || true
    fi
    if [[ -n "$GROUP_ID" && -n "$TOKEN" ]]; then
      curl -sS -o /dev/null -X DELETE \
        -H "Authorization: Bearer $TOKEN" \
        "${BASE_URL}/api/groups/${GROUP_ID}" 2>/dev/null || true
    fi
  fi
}
trap cleanup_on_exit EXIT

# ─────────────────────────────────────────────────────────────────────────
info 1 "Health"
HEALTH_RESP="$(curl -sS --fail-with-body "${BASE_URL}/api/health" 2>&1)" \
  || fail_step 1 "GET /api/health unreachable or non-2xx: ${HEALTH_RESP}"
STATUS="$(jq -r .status <<<"$HEALTH_RESP" 2>/dev/null || echo '')"
[[ "$STATUS" == "ok" ]] \
  || fail_step 1 "Health payload missing status=ok: ${HEALTH_RESP}"
ok "API healthy at ${BASE_URL}"

# ─────────────────────────────────────────────────────────────────────────
info 2 "Login (orchestrator bot)"
# Build the login JSON with jq so a password containing quotes or
# backslashes can't break the payload or land in the shell history.
# shellcheck disable=SC2016  # $email/$password are jq vars, not shell
LOGIN_BODY="$(jq -nc --arg email "$BOT_EMAIL" --arg password "$BOT_PASSWORD" \
  '{email:$email, password:$password}')"
LOGIN_RESP="$(curl -sS --fail-with-body \
  -H 'Content-Type: application/json' \
  -d "$LOGIN_BODY" \
  "${BASE_URL}/api/auth/login" 2>&1)" \
  || fail_step 2 "login HTTP error (check SMOKE_BOT_EMAIL / seeded bot)"
TOKEN="$(jq -r .accessToken <<<"$LOGIN_RESP" 2>/dev/null || echo '')"
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] \
  || fail_step 2 "login response missing accessToken"
ok "Access token acquired for ${BOT_EMAIL}"

# ─────────────────────────────────────────────────────────────────────────
info 3 "Create group"
GROUP_BODY="$(jq -nc --arg name "$GROUP_NAME" \
  '{name:$name, description:"OPS1 smoke", defaultServings:2}')"
GROUP_RESP="$(curl -sS --fail-with-body \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$GROUP_BODY" \
  "${BASE_URL}/api/groups/" 2>&1)" \
  || fail_step 3 "POST /api/groups failed: ${GROUP_RESP}"
GROUP_ID="$(jq -r .id <<<"$GROUP_RESP" 2>/dev/null || echo '')"
[[ -n "$GROUP_ID" && "$GROUP_ID" != "null" ]] \
  || fail_step 3 "group response missing id: ${GROUP_RESP}"
ok "Group created: ${GROUP_NAME} (${GROUP_ID})"

# ─────────────────────────────────────────────────────────────────────────
info 4 "Create recipe"
RECIPE_BODY="$(jq -nc --arg title "$RECIPE_TITLE" '{
  title: $title,
  description: "Minimal smoke recipe",
  defaultServings: 2,
  prepTimeMinutes: 5,
  difficulty: 1,
  sourceUrl: null,
  ingredients: [
    { position: 0, quantity: 1, unit: "Stück", name: "Wasser", note: null, scalable: true }
  ],
  steps: [
    { position: 0, content: "Einfach anrichten." }
  ],
  tagIds: []
}')"
RECIPE_RESP="$(curl -sS --fail-with-body \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$RECIPE_BODY" \
  "${BASE_URL}/api/groups/${GROUP_ID}/recipes/" 2>&1)" \
  || fail_step 4 "POST /api/groups/${GROUP_ID}/recipes failed: ${RECIPE_RESP}"
RECIPE_ID="$(jq -r .id <<<"$RECIPE_RESP" 2>/dev/null || echo '')"
[[ -n "$RECIPE_ID" && "$RECIPE_ID" != "null" ]] \
  || fail_step 4 "recipe response missing id: ${RECIPE_RESP}"
ok "Recipe created: ${RECIPE_TITLE} (${RECIPE_ID})"

# ─────────────────────────────────────────────────────────────────────────
info 5 "Rate recipe (5 ★)"
RATE_RESP="$(curl -sS --fail-with-body \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"stars":5,"comment":"Smoke"}' \
  "${BASE_URL}/api/recipes/${RECIPE_ID}/ratings/" 2>&1)" \
  || fail_step 5 "POST rating failed: ${RATE_RESP}"
RATE_STARS="$(jq -r .rating.stars <<<"$RATE_RESP" 2>/dev/null || echo '')"
[[ "$RATE_STARS" == "5" ]] \
  || fail_step 5 "rating upsert did not return stars=5: ${RATE_RESP}"
ok "Rating upserted (5★)"

# ─────────────────────────────────────────────────────────────────────────
info 6 "Fetch recipe — verify averageRating ≈ 5"
# Recipe detail doesn't carry the aggregate, but the ratings list does;
# and a GET of the recipe itself confirms the read path end-to-end.
curl -sS --fail-with-body -o /dev/null \
  -H "Authorization: Bearer $TOKEN" \
  "${BASE_URL}/api/recipes/${RECIPE_ID}" \
  || fail_step 6 "GET /api/recipes/${RECIPE_ID} failed"
AGG_RESP="$(curl -sS --fail-with-body \
  -H "Authorization: Bearer $TOKEN" \
  "${BASE_URL}/api/recipes/${RECIPE_ID}/ratings/" 2>&1)" \
  || fail_step 6 "GET ratings failed: ${AGG_RESP}"
AVG="$(jq -r '.aggregate.avg // empty' <<<"$AGG_RESP" 2>/dev/null || echo '')"
[[ -n "$AVG" ]] \
  || fail_step 6 "ratings aggregate missing avg: ${AGG_RESP}"
# Tolerate floating-point noise around 5.0 (avg is double in JSON).
# Accepts 4.9 ≤ avg ≤ 5.1 — any tighter would flake on decimal formatting.
AVG_OK="$(jq -n --argjson avg "$AVG" '($avg >= 4.9) and ($avg <= 5.1)')"
[[ "$AVG_OK" == "true" ]] \
  || fail_step 6 "averageRating not ≈ 5 (got ${AVG})"
ok "averageRating=${AVG} within tolerance"

# ─────────────────────────────────────────────────────────────────────────
info 7 "Cook marker"
COOK_RESP="$(curl -sS --fail-with-body \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -X POST \
  "${BASE_URL}/api/recipes/${RECIPE_ID}/cook" 2>&1)" \
  || fail_step 7 "POST /cook failed: ${COOK_RESP}"
LAST_COOKED="$(jq -r '.lastCookedAt // empty' <<<"$COOK_RESP" 2>/dev/null || echo '')"
[[ -n "$LAST_COOKED" ]] \
  || fail_step 7 "cook response missing lastCookedAt: ${COOK_RESP}"
ok "lastCookedAt=${LAST_COOKED}"

# ─────────────────────────────────────────────────────────────────────────
info 8 "Cleanup (best-effort)"
DELETE_RECIPE_HTTP="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  "${BASE_URL}/api/recipes/${RECIPE_ID}")"
case "$DELETE_RECIPE_HTTP" in
  2*)   ok "recipe deleted (HTTP ${DELETE_RECIPE_HTTP})" ;;
  404)  warn "recipe already gone (HTTP 404)" ;;
  *)    warn "recipe DELETE returned HTTP ${DELETE_RECIPE_HTTP} (continuing)" ;;
esac

DELETE_GROUP_HTTP="$(curl -sS -o /dev/null -w '%{http_code}' \
  -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  "${BASE_URL}/api/groups/${GROUP_ID}")"
case "$DELETE_GROUP_HTTP" in
  2*)   ok "group deleted (HTTP ${DELETE_GROUP_HTTP})" ;;
  404)  warn "group already gone (HTTP 404)" ;;
  *)    warn "group DELETE returned HTTP ${DELETE_GROUP_HTTP} (continuing)" ;;
esac

# Reset so the EXIT trap's best-effort cleanup is a no-op on the happy path.
RECIPE_ID=""
GROUP_ID=""

# ─────────────────────────────────────────────────────────────────────────
printf '\n✓ SMOKE PASSED (%d/%d)\n' "$TOTAL_STEPS" "$TOTAL_STEPS"
