#!/usr/bin/env bash
# Familien-Kochbuch end-to-end smoke test.
#
# Exercises the complete happy-path flow through Caddy → API:
#   1. Wait for /api/health to be OK (up to 90 s)
#   2. Log in as seeded admin
#   3. Create app invite → capture token
#   4. Sign up test user via that invite → auto-login
#   5. Re-login as test user
#   6. Create a collaborative group
#   7. Create a recipe (5 ingredients, 3 steps, 2 tags)
#   8. Rate it 5 stars
#   9. Search for it by title substring
#   10. Fork into the test group
#   11. Verify the fork's revision log mentions "Geforkt"
#   12. Delete the test recipe
#   13. Delete the test group
#
# Exits 0 on success, non-zero with a clear error on any failed step.
# Requires: bash, curl, jq.

set -euo pipefail

BASE_URL="${SMOKE_BASE_URL:-http://localhost}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@familien-kochbuch.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-ChangeMe!Admin2026}"
STAMP="$(date +%s)"
TEST_EMAIL="smoke-${STAMP}@familien-kochbuch.local"
TEST_PASSWORD="SmokeTest${STAMP}!"
TEST_DISPLAY="Smoke-${STAMP}"
GROUP_NAME="Smoke-G-${STAMP}"
RECIPE_TITLE="Smoke-Rezept-${STAMP}"

ok() { printf '  ✓ %s\n' "$*"; }
info() { printf '▶ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null || fail "Missing dependency: $1"
}
require curl
require jq

# ---------------------------------------------------------------------------
info "Step 1/13 — wait for /api/health"
ATTEMPTS=0
until curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if (( ATTEMPTS > 90 )); then
    fail "API did not become healthy within 90 s at ${BASE_URL}"
  fi
  sleep 1
done
ok "API healthy at ${BASE_URL}/api/health"

# ---------------------------------------------------------------------------
info "Step 2/13 — log in as seeded admin"
ADMIN_RESP="$(curl -fsS -c /tmp/fk-smoke-admin.cookies \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
  "${BASE_URL}/api/auth/login")"
ADMIN_TOKEN="$(jq -r .accessToken <<<"$ADMIN_RESP")"
[[ "$ADMIN_TOKEN" != "null" && -n "$ADMIN_TOKEN" ]] \
  || fail "Admin login failed: $ADMIN_RESP"
ok "Admin access token acquired"

# ---------------------------------------------------------------------------
info "Step 3/13 — generate app invite"
INVITE_RESP="$(curl -fsS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}' \
  "${BASE_URL}/api/invites/app/")"
INVITE_TOKEN="$(jq -r .token <<<"$INVITE_RESP")"
[[ -n "$INVITE_TOKEN" && "$INVITE_TOKEN" != "null" ]] \
  || fail "Invite creation failed: $INVITE_RESP"
ok "Invite token captured"

# ---------------------------------------------------------------------------
info "Step 4/13 — sign up test user via invite"
SIGNUP_RESP="$(curl -fsS -c /tmp/fk-smoke-user.cookies \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"${TEST_PASSWORD}\",\"displayName\":\"${TEST_DISPLAY}\"}" \
  "${BASE_URL}/api/auth/signup?token=${INVITE_TOKEN}")"
SIGNUP_TOKEN="$(jq -r .accessToken <<<"$SIGNUP_RESP")"
[[ -n "$SIGNUP_TOKEN" && "$SIGNUP_TOKEN" != "null" ]] \
  || fail "Signup failed: $SIGNUP_RESP"
ok "Signup returned an access token for ${TEST_EMAIL}"

# ---------------------------------------------------------------------------
info "Step 5/13 — re-login as test user"
LOGIN_RESP="$(curl -fsS -c /tmp/fk-smoke-user.cookies \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"${TEST_PASSWORD}\"}" \
  "${BASE_URL}/api/auth/login")"
USER_TOKEN="$(jq -r .accessToken <<<"$LOGIN_RESP")"
[[ -n "$USER_TOKEN" && "$USER_TOKEN" != "null" ]] \
  || fail "Re-login failed: $LOGIN_RESP"
ok "Re-login succeeded"

# ---------------------------------------------------------------------------
info "Step 6/13 — create a collaborative group"
GROUP_RESP="$(curl -fsS \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"${GROUP_NAME}\",\"description\":\"smoke\",\"defaultServings\":4}" \
  "${BASE_URL}/api/groups/")"
GROUP_ID="$(jq -r .id <<<"$GROUP_RESP")"
[[ -n "$GROUP_ID" && "$GROUP_ID" != "null" ]] \
  || fail "Group creation failed: $GROUP_RESP"
ok "Group created: ${GROUP_NAME} (${GROUP_ID})"

# ---------------------------------------------------------------------------
info "Step 7/13 — create recipe with 5 ingredients, 3 steps, 2 tags"
# Resolve 2 global tags to attach.
TAGS_RESP="$(curl -fsS \
  -H "Authorization: Bearer $USER_TOKEN" \
  "${BASE_URL}/api/groups/${GROUP_ID}/tags")"
TAG1="$(jq -r '.[] | select(.isGlobal) | .id' <<<"$TAGS_RESP" | sed -n '1p')"
TAG2="$(jq -r '.[] | select(.isGlobal) | .id' <<<"$TAGS_RESP" | sed -n '2p')"
[[ -n "$TAG1" && -n "$TAG2" ]] || fail "Expected at least 2 global tags — got: $TAGS_RESP"

RECIPE_BODY=$(jq -n \
  --arg title "$RECIPE_TITLE" \
  --arg tag1 "$TAG1" \
  --arg tag2 "$TAG2" \
  '{
    title: $title,
    description: "Smoke test recipe",
    defaultServings: 4,
    prepTimeMinutes: 30,
    difficulty: 2,
    sourceUrl: null,
    ingredients: [
      { position: 0, quantity: 500, unit: "g",     name: "Mehl",       note: null, scalable: true  },
      { position: 1, quantity: 2,   unit: "Stück", name: "Eier",       note: null, scalable: true  },
      { position: 2, quantity: 1,   unit: "TL",    name: "Salz",       note: null, scalable: false },
      { position: 3, quantity: 250, unit: "ml",    name: "Milch",      note: null, scalable: true  },
      { position: 4, quantity: 100, unit: "g",     name: "Butter",     note: null, scalable: true  }
    ],
    steps: [
      { position: 0, content: "Zutaten verrühren." },
      { position: 1, content: "Teig ruhen lassen." },
      { position: 2, content: "In der Pfanne ausbacken." }
    ],
    tagIds: [ $tag1, $tag2 ]
  }')

RECIPE_RESP="$(curl -fsS \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$RECIPE_BODY" \
  "${BASE_URL}/api/groups/${GROUP_ID}/recipes/")"
RECIPE_ID="$(jq -r .id <<<"$RECIPE_RESP")"
[[ -n "$RECIPE_ID" && "$RECIPE_ID" != "null" ]] \
  || fail "Recipe creation failed: $RECIPE_RESP"
ok "Recipe created: ${RECIPE_TITLE} (${RECIPE_ID})"

# ---------------------------------------------------------------------------
info "Step 8/13 — rate recipe 5 stars"
RATE_RESP="$(curl -fsS \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"stars":5,"comment":"Super!"}' \
  "${BASE_URL}/api/recipes/${RECIPE_ID}/ratings/")"
RATE_STARS="$(jq -r .rating.stars <<<"$RATE_RESP")"
[[ "$RATE_STARS" == "5" ]] || fail "Rating upsert did not return 5 stars: $RATE_RESP"
ok "Rating upserted (5★)"

# ---------------------------------------------------------------------------
info "Step 9/13 — search recipe by title substring"
SEARCH_RESP="$(curl -fsS \
  -H "Authorization: Bearer $USER_TOKEN" \
  "${BASE_URL}/api/groups/${GROUP_ID}/recipes/search?q=Smoke")"
HITS="$(jq -r '.items | length' <<<"$SEARCH_RESP")"
[[ "$HITS" -ge 1 ]] || fail "Search returned no hits for 'Smoke': $SEARCH_RESP"
ok "Search returned ${HITS} hit(s) for 'Smoke'"

# ---------------------------------------------------------------------------
info "Step 10/13 — fork the recipe into a second group"
FORK_TARGET_NAME="Smoke-Fork-${STAMP}"
FORK_GROUP_RESP="$(curl -fsS \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"${FORK_TARGET_NAME}\"}" \
  "${BASE_URL}/api/groups/")"
FORK_GROUP_ID="$(jq -r .id <<<"$FORK_GROUP_RESP")"
[[ -n "$FORK_GROUP_ID" && "$FORK_GROUP_ID" != "null" ]] \
  || fail "Fork-target group creation failed: $FORK_GROUP_RESP"

FORK_RESP="$(curl -fsS \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"targetGroupId\":\"${FORK_GROUP_ID}\"}" \
  "${BASE_URL}/api/recipes/${RECIPE_ID}/fork")"
FORK_ID="$(jq -r .id <<<"$FORK_RESP")"
FORK_OF="$(jq -r .forkOfRecipeId <<<"$FORK_RESP")"
[[ -n "$FORK_ID" && "$FORK_ID" != "null" && "$FORK_OF" == "$RECIPE_ID" ]] \
  || fail "Fork response missing forkOfRecipeId: $FORK_RESP"
ok "Fork created (${FORK_ID}) with forkOfRecipeId=${RECIPE_ID}"

# ---------------------------------------------------------------------------
info "Step 11/13 — verify fork's revision log mentions 'Geforkt'"
REV_RESP="$(curl -fsS \
  -H "Authorization: Bearer $USER_TOKEN" \
  "${BASE_URL}/api/recipes/${FORK_ID}/revisions")"
FIRST_SUMMARY="$(jq -r '.[0].diffSummary' <<<"$REV_RESP")"
[[ "$FIRST_SUMMARY" == *Geforkt* ]] \
  || fail "Fork's first revision summary didn't mention 'Geforkt': $FIRST_SUMMARY"
ok "Fork revision summary: ${FIRST_SUMMARY}"

# ---------------------------------------------------------------------------
info "Step 12/13 — delete the test recipe"
curl -fsS -o /dev/null -X DELETE \
  -H "Authorization: Bearer $USER_TOKEN" \
  "${BASE_URL}/api/recipes/${RECIPE_ID}"
ok "Test recipe deleted"

# ---------------------------------------------------------------------------
info "Step 13/13 — delete the test groups"
curl -fsS -o /dev/null -X DELETE \
  -H "Authorization: Bearer $USER_TOKEN" \
  "${BASE_URL}/api/groups/${GROUP_ID}"
curl -fsS -o /dev/null -X DELETE \
  -H "Authorization: Bearer $USER_TOKEN" \
  "${BASE_URL}/api/groups/${FORK_GROUP_ID}"
ok "Test groups deleted"

# ---------------------------------------------------------------------------
echo
echo "✓ Familien-Kochbuch smoke test passed (${BASE_URL})"
