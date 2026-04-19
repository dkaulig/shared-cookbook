#!/usr/bin/env bash
# Familien-Kochbuch live smoke test (OPS1 + PV4).
#
# Two modes:
#
# 1. CRUD mode (default) — the original 8-step OPS1 happy-path:
#   1. Health          — GET  /api/health
#   2. Login           — POST /api/auth/login                          (bot)
#   3. Create group    — POST /api/groups
#   4. Create recipe   — POST /api/groups/{groupId}/recipes
#   5. Rate recipe     — POST /api/recipes/{recipeId}/ratings    (5 ★)
#   6. Fetch recipe    — GET  /api/recipes/{recipeId}/ratings  (avg ≈ 5)
#   7. Cook marker     — POST /api/recipes/{recipeId}/cook
#   8. Cleanup         — DELETE recipe + group (best-effort)
#
# 2. URL-import mode (PV4) — triggered by `--import-url=<url>`:
#   1. Health          — GET  /api/health
#   2. Login           — POST /api/auth/login                          (bot)
#   3. Create group    — POST /api/groups
#   4. Enqueue import  — POST /api/recipes/import/url
#   5. Poll progress   — GET  /api/imports/{importId} every 2 s
#                        (≥ 3 distinct phase snapshots required)
#   6. Verify result   — title + ≥1 ingredient in the extracted recipe
#   7. Cleanup         — DELETE group (cascade)
#
# Exits 0 on full green; non-zero with a clear step-number error on failure.
# Cleanup on steps 1-7 pass is guaranteed; on failure we still *try* to
# clean up whatever we managed to create before bailing.
#
# Env vars:
#   SMOKE_BASE_URL       default https://kochbuch.kaulig.dev
#   SMOKE_BOT_EMAIL      default orchestrator@kochbuch.kaulig.dev
#   SMOKE_BOT_PASSWORD   REQUIRED — no default; never hardcoded.
#
# Flags:
#   --import-url=<url>   run URL-import mode against <url>
#
# Requires: bash ≥ 3.2 (macOS default), curl, jq.

set -euo pipefail

command -v jq >/dev/null || { echo "jq required" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl required" >&2; exit 2; }

BASE_URL="${SMOKE_BASE_URL:-https://kochbuch.kaulig.dev}"
BOT_EMAIL="${SMOKE_BOT_EMAIL:-orchestrator@kochbuch.kaulig.dev}"
BOT_PASSWORD="${SMOKE_BOT_PASSWORD:-}"

# ── Argument parsing ─────────────────────────────────────────────────────
# --import-url=<url>  switches to PV4 URL-import mode (poll + phase assert).
# No flag → original 8-step CRUD mode. If --import-url is given with no
# value, or an unknown flag is passed, fail fast with usage.
IMPORT_URL=""
usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/smoke-live.sh                           # 8-step CRUD smoke
  scripts/smoke-live.sh --import-url=<url>        # PV4 URL-import smoke

Env (both modes):
  SMOKE_BASE_URL       default https://kochbuch.kaulig.dev
  SMOKE_BOT_EMAIL      default orchestrator@kochbuch.kaulig.dev
  SMOKE_BOT_PASSWORD   REQUIRED
EOF
}
for arg in "$@"; do
  case "$arg" in
    --import-url=*)
      IMPORT_URL="${arg#--import-url=}"
      if [[ -z "$IMPORT_URL" ]]; then
        printf '✗ --import-url requires a non-empty URL.\n' >&2
        usage
        exit 2
      fi
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf '✗ Unknown argument: %s\n' "$arg" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -n "$IMPORT_URL" ]]; then
  TOTAL_STEPS=7
else
  TOTAL_STEPS=8
fi
EPOCH="$(date +%s)"
GROUP_NAME="Smoke-Test-Group-${EPOCH}"
RECIPE_TITLE="Smoke-Test-Recipe-${EPOCH}"

# Populated as the flow progresses — used by the trap-driven cleanup on
# early failure so we never leak a half-built group/recipe into prod.
TOKEN=""
GROUP_ID=""
RECIPE_ID=""
IMPORT_ID=""

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
GROUP_DESC="OPS1 smoke"
[[ -n "$IMPORT_URL" ]] && GROUP_DESC="PV4 import smoke"
GROUP_BODY="$(jq -nc --arg name "$GROUP_NAME" --arg desc "$GROUP_DESC" \
  '{name:$name, description:$desc, defaultServings:2}')"
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
# Branch point: PV4 import-mode takes over here and runs its own steps
# 4-7. The original CRUD mode continues with steps 4-8 below.
if [[ -n "$IMPORT_URL" ]]; then
  # ── Step 4: Enqueue URL import ─────────────────────────────────────────
  info 4 "Enqueue URL import"
  IMPORT_BODY="$(jq -nc --arg url "$IMPORT_URL" --arg groupId "$GROUP_ID" \
    '{url:$url, groupId:$groupId}')"
  IMPORT_RESP="$(curl -sS --fail-with-body \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$IMPORT_BODY" \
    "${BASE_URL}/api/recipes/import/url" 2>&1)" \
    || fail_step 4 "POST /api/recipes/import/url failed: ${IMPORT_RESP}"
  IMPORT_ID="$(jq -r .importId <<<"$IMPORT_RESP" 2>/dev/null || echo '')"
  [[ -n "$IMPORT_ID" && "$IMPORT_ID" != "null" ]] \
    || fail_step 4 "import response missing importId: ${IMPORT_RESP}"
  ok "Import enqueued: ${IMPORT_ID}"

  # ── Step 5: Poll + collect ≥3 distinct (phase, progress) snapshots ──
  # PV4 — the GET /api/imports/:id endpoint now carries `phase` directly
  # (snake-case wire form), but this smoke script keeps the legacy
  # progress-bucketing logic below so it remains backward compatible
  # with older API versions in a mixed-deploy window. The integer-based
  # mapping follows `PhaseWeightedFormula` (RecipeImport.cs §RangeOf).
  #   0..4   → queued
  #   5..14  → downloading
  #   15..84 → transcribing
  #   85..94 → structuring
  #   95..99 → post_processing
  #   100    → done
  # A single observed progress might skip through multiple buckets
  # between polls, so we record every bucket the integer PASSED THROUGH
  # by also translating each poll's progress into a bucket-label.
  info 5 "Poll import progress (≥3 distinct phases, 10-min timeout)"
  POLL_DEADLINE=$(( $(date +%s) + 600 ))
  LAST_STATUS=""
  LAST_PROGRESS=-1
  LAST_BODY=""
  # bash 3.2 has no associative arrays; a space-separated string acts as
  # an ordered "set" — we only append a phase label the first time we
  # see it, preserving observation order.
  OBSERVED_PHASES=""
  OBSERVED_COUNT=0
  phase_for_progress() {
    local p="$1"
    if   [[ "$p" -ge 100 ]]; then printf 'done'
    elif [[ "$p" -ge 95  ]]; then printf 'post_processing'
    elif [[ "$p" -ge 85  ]]; then printf 'structuring'
    elif [[ "$p" -ge 15  ]]; then printf 'transcribing'
    elif [[ "$p" -ge 5   ]]; then printf 'downloading'
    else                          printf 'queued'
    fi
  }
  record_phase() {
    local label="$1"
    case " $OBSERVED_PHASES " in
      *" $label "*) ;;  # already seen — no-op
      *)
        if [[ -z "$OBSERVED_PHASES" ]]; then
          OBSERVED_PHASES="$label"
        else
          OBSERVED_PHASES="$OBSERVED_PHASES $label"
        fi
        OBSERVED_COUNT=$((OBSERVED_COUNT + 1))
        ;;
    esac
  }

  while :; do
    NOW="$(date +%s)"
    if [[ "$NOW" -gt "$POLL_DEADLINE" ]]; then
      fail_step 5 "import still not Done after 10 min; last status=${LAST_STATUS} progress=${LAST_PROGRESS} phases=[${OBSERVED_PHASES}]"
    fi

    POLL_HTTP="$(curl -sS -o /tmp/smoke-import-$$.json -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      "${BASE_URL}/api/imports/${IMPORT_ID}" 2>/dev/null || echo '000')"
    if [[ "$POLL_HTTP" != 2* ]]; then
      LAST_BODY="$(cat /tmp/smoke-import-$$.json 2>/dev/null || echo '')"
      rm -f /tmp/smoke-import-$$.json
      fail_step 5 "GET /api/imports/${IMPORT_ID} returned HTTP ${POLL_HTTP}: ${LAST_BODY}"
    fi
    LAST_BODY="$(cat /tmp/smoke-import-$$.json)"
    rm -f /tmp/smoke-import-$$.json

    # jq's -r on a missing key emits '' — guard with // "".
    LAST_STATUS="$(jq -r '.status // ""' <<<"$LAST_BODY" 2>/dev/null || echo '')"
    PROGRESS_RAW="$(jq -r '.progress // 0' <<<"$LAST_BODY" 2>/dev/null || echo '0')"
    # Guard against non-numeric progress so the [[ -ge ]] doesn't explode.
    if [[ "$PROGRESS_RAW" =~ ^[0-9]+$ ]]; then
      LAST_PROGRESS="$PROGRESS_RAW"
    else
      LAST_PROGRESS=0
    fi

    PHASE_LABEL="$(phase_for_progress "$LAST_PROGRESS")"
    record_phase "$PHASE_LABEL"

    # Status string is TitleCase on the wire ("Done" / "Error").
    LAST_STATUS_LOWER="$(printf '%s' "$LAST_STATUS" | tr '[:upper:]' '[:lower:]')"
    if [[ "$LAST_STATUS_LOWER" == "error" ]]; then
      ERR_MSG="$(jq -r '.error // ""' <<<"$LAST_BODY" 2>/dev/null || echo '')"
      fail_step 5 "import terminated with status=error: ${ERR_MSG}"
    fi
    if [[ "$LAST_STATUS_LOWER" == "done" ]]; then
      # Ensure 'done' is in the phase set even if progress jumped 99→100
      # between polls (the progress bucketer returns 'done' only at 100).
      record_phase "done"
      break
    fi

    printf '  … status=%s progress=%d phase=%s (observed=%d)\n' \
      "$LAST_STATUS" "$LAST_PROGRESS" "$PHASE_LABEL" "$OBSERVED_COUNT"
    sleep 2
  done

  if [[ "$OBSERVED_COUNT" -lt 3 ]]; then
    fail_step 5 "only observed ${OBSERVED_COUNT} distinct phases (need ≥3): [${OBSERVED_PHASES}]"
  fi
  ok "Observed ${OBSERVED_COUNT} distinct phases: [${OBSERVED_PHASES}]"

  # ── Step 6: Verify extraction result ──────────────────────────────────
  info 6 "Verify extraction result (title + ≥1 ingredient)"
  # `result` is a JSON STRING on the wire (server double-encodes it);
  # parse with fromjson after pulling out the string.
  RESULT_TITLE="$(jq -r '(.result // "") | if . == "" then "" else (. | fromjson | .recipe.title // "") end' \
    <<<"$LAST_BODY" 2>/dev/null || echo '')"
  [[ -n "$RESULT_TITLE" ]] \
    || fail_step 6 "extracted recipe has empty title (result payload: $(jq -r '.result // "<null>"' <<<"$LAST_BODY"))"
  INGREDIENT_COUNT="$(jq -r '(.result // "") | if . == "" then 0 else (. | fromjson | .recipe.ingredients | length) end' \
    <<<"$LAST_BODY" 2>/dev/null || echo '0')"
  if ! [[ "$INGREDIENT_COUNT" =~ ^[0-9]+$ ]]; then
    INGREDIENT_COUNT=0
  fi
  [[ "$INGREDIENT_COUNT" -ge 1 ]] \
    || fail_step 6 "extracted recipe has 0 ingredients"
  ok "Title=\"${RESULT_TITLE}\", ingredients=${INGREDIENT_COUNT}"

  # ── Step 7: Cleanup (group delete cascades to imports/recipes) ───────
  info 7 "Cleanup (delete group — cascade)"
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
  GROUP_ID=""
  IMPORT_ID=""

  printf '\n✓ SMOKE PASSED (%d/%d) — import-mode\n' "$TOTAL_STEPS" "$TOTAL_STEPS"
  printf '✓ Observed %d distinct phases: [%s]\n' "$OBSERVED_COUNT" "$OBSERVED_PHASES"
  exit 0
fi
# ─────────────────────────────────────────────────────────────────────────
# Original CRUD mode continues from here — no changes below this line.

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
