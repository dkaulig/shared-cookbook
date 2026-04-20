#!/usr/bin/env bash
# Familien-Kochbuch AI-chat smoke test (Phase CR, post-CR5).
#
# Exercises the native .NET chat surface end-to-end without hitting the
# Python extractor. CR5 removed the Python POST /chat turn endpoint;
# chat turns are now served by .NET + Azure OpenAI SSE streaming, and
# only the to-recipe conversion proxy still forwards to Python.
#
# Five steps, all against the running .NET API:
#   1. Login           — POST /api/auth/login                          (bot)
#   2. Create session  — POST /api/chat/sessions
#   3. Send first turn — POST /api/chat/sessions/{id}/turn   (SSE read)
#                        Streams tokens until `event: done` arrives.
#   4. History count   — GET  /api/chat/sessions/{id}/messages
#                        (expect 2 rows: 1 user + 1 assistant)
#   5. Delete session  — DELETE /api/chat/sessions/{id}       (expect 204)
#
# Exits 0 on full green; non-zero with a clear step-number error on failure.
# Best-effort cleanup on early failure.
#
# Env vars:
#   SMOKE_BASE_URL       default https://EXAMPLE_HOST
#   SMOKE_BOT_EMAIL      default orchestrator@EXAMPLE_HOST
#   SMOKE_BOT_PASSWORD   REQUIRED — no default; never hardcoded.
#   SMOKE_CHAT_PROMPT    default "Hallo"
#
# Requires: bash >= 3.2, curl, jq.

set -euo pipefail

command -v jq >/dev/null || { echo "jq required" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl required" >&2; exit 2; }

BASE_URL="${SMOKE_BASE_URL:-https://EXAMPLE_HOST}"
BOT_EMAIL="${SMOKE_BOT_EMAIL:-orchestrator@EXAMPLE_HOST}"
BOT_PASSWORD="${SMOKE_BOT_PASSWORD:-}"
CHAT_PROMPT="${SMOKE_CHAT_PROMPT:-Hallo}"

if [ -z "$BOT_PASSWORD" ]; then
  echo "SMOKE_BOT_PASSWORD is required (see docs/ops.md §6.1)" >&2
  exit 2
fi

fail() {
  local step="$1" msg="$2"
  echo "SMOKE FAILED at step $step: $msg" >&2
  if [ -n "${SESSION_ID:-}" ] && [ -n "${TOKEN:-}" ]; then
    echo "  cleanup: DELETE /api/chat/sessions/$SESSION_ID" >&2
    curl -sS -X DELETE \
      -H "Authorization: Bearer $TOKEN" \
      "$BASE_URL/api/chat/sessions/$SESSION_ID" >/dev/null || true
  fi
  exit 1
}

# ── Step 1: login ────────────────────────────────────────────────────────
echo "1/5  login as $BOT_EMAIL ..."
LOGIN_BODY=$(jq -n --arg e "$BOT_EMAIL" --arg p "$BOT_PASSWORD" \
  '{email:$e, password:$p}')
LOGIN_RESP=$(curl -sS -X POST \
  -H 'Content-Type: application/json' \
  --data-raw "$LOGIN_BODY" \
  "$BASE_URL/api/auth/login") \
  || fail 1 "auth/login transport error"
TOKEN=$(echo "$LOGIN_RESP" | jq -er '.accessToken') \
  || fail 1 "no accessToken in response: $LOGIN_RESP"

# ── Step 2: create session ───────────────────────────────────────────────
echo "2/5  POST /api/chat/sessions ..."
SESSION_RESP=$(curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-raw '{}' \
  "$BASE_URL/api/chat/sessions") \
  || fail 2 "POST /api/chat/sessions transport error"
SESSION_ID=$(echo "$SESSION_RESP" | jq -er '.sessionId') \
  || fail 2 "no sessionId in response: $SESSION_RESP"
echo "     → sessionId=$SESSION_ID"

# ── Step 3: SSE turn ─────────────────────────────────────────────────────
echo "3/5  POST /api/chat/sessions/$SESSION_ID/turn (SSE, prompt: $CHAT_PROMPT) ..."
TURN_BODY=$(jq -n --arg c "$CHAT_PROMPT" '{content:$c}')
# Stream until the first `event: done` line appears. curl writes to stdout
# line-buffered; awk exits on done which closes the pipe and curl aborts.
TURN_OUT=$(curl -sS -N -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  --data-raw "$TURN_BODY" \
  "$BASE_URL/api/chat/sessions/$SESSION_ID/turn" \
  | awk '/^event: done$/ {print; exit} {print}') \
  || fail 3 "turn stream aborted"
if ! echo "$TURN_OUT" | grep -q '^event: done$'; then
  fail 3 "no event: done in stream output (truncated or error?)"
fi
if ! echo "$TURN_OUT" | grep -q '^event: token$'; then
  fail 3 "no token events in stream (provider outage?)"
fi

# ── Step 4: history count ────────────────────────────────────────────────
echo "4/5  GET /api/chat/sessions/$SESSION_ID/messages ..."
HIST=$(curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/chat/sessions/$SESSION_ID/messages") \
  || fail 4 "messages fetch transport error"
COUNT=$(echo "$HIST" | jq -r '. | length')
if [ "$COUNT" != "2" ]; then
  fail 4 "expected 2 messages (1 user + 1 assistant), got $COUNT: $HIST"
fi

# ── Step 5: delete ───────────────────────────────────────────────────────
echo "5/5  DELETE /api/chat/sessions/$SESSION_ID ..."
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/chat/sessions/$SESSION_ID")
if [ "$STATUS" != "204" ] && [ "$STATUS" != "200" ]; then
  fail 5 "unexpected status $STATUS"
fi

echo "SMOKE PASSED (5/5)"
