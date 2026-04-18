# P2-6 — .NET ↔ Python Bridge Endpoints

**Slice:** P2-6
**Status:** planned
**Date:** 2026-04-18
**Depends on:** P2-5 (Hangfire + RecipeImport) + P2-2 / P2-3 / P2-4 (Python endpoints ready).
**Parent plan:** `docs/plans/2026-04-18-phase-2-architecture.md`.

## Why

Frontend never talks to the Python service directly. The .NET API exposes user-facing import endpoints, validates auth, enqueues Hangfire jobs, and returns import IDs for polling.

## Scope

### 1. User-facing endpoints

All behind `RequireAuthorization()`, all return 202 Accepted + `{ importId }` (fire-and-forget).

- `POST /api/recipes/import/url` — body `{ url, groupId }`. Creates `RecipeImport(Source=Url, Status=Queued)`, enqueues `ExtractRecipeFromUrlJob(importId)`. Validates: URL is a valid absolute URL, caller is a member of `groupId`.

- `POST /api/recipes/import/photos` — body `{ photoUrls: string[], groupId }`. Creates `RecipeImport(Source=Photos, Status=Queued)`, enqueues `ExtractRecipeFromPhotosJob(importId)`. Validates: photos 1..10, caller is member of groupId, each URL is a signed-URL owned by caller (re-use existing photo HMAC verify).

- `POST /api/chat` — body `{ sessionId, messages }`. **Synchronous** (not a Hangfire job; chat turn is < 5s). Forwards to Python `POST /chat`, returns `{ assistantMessage }`.

- `POST /api/chat/{sessionId}/to-recipe` — body `{ messages }`. **Synchronous** (structuring LLM call, 2–10s). Forwards to Python `POST /chat/{sid}/to-recipe`, returns the `ExtractionResult`.

### 2. Status endpoint (from P2-5)

Already exists: `GET /api/imports/{importId}`. Frontend polls this every 2s.

### 3. HTTP client factory to Python

- `IHttpClientFactory`-named client `python-extractor` with `BaseAddress=http://python-extractor:8000`, 120s timeout.
- HMAC signer (implemented in P2-5) injects `X-Extractor-Signature` + `X-Extractor-Timestamp` + `X-User-Id` headers.

### 4. Error mapping (Python → .NET HTTP)

- Python 422 (invalid URL) → .NET 400.
- Python 503 (LLM outage) → .NET 503 with German message "KI-Service momentan nicht erreichbar".
- Python network timeout → .NET 504 + job retries in Hangfire (async path only).
- Python 401 (HMAC mismatch) → .NET 500 with internal error logged, no user-visible leak.

### 5. Tests

Integration tests:
- Enqueue endpoint happy path: import created with `Status=Queued`, job enqueued (Hangfire.InMemory backend).
- Non-member of group → 403 on all three user-facing endpoints.
- Anonymous → 401.
- URL endpoint validates URL format.
- Photo endpoint validates count (0 → 400, 11 → 400).
- Chat endpoint proxies correctly with mocked `HttpClient`.
- Chat-to-recipe proxies + returns the ExtractionResult shape.
- Error-mapping: Python 503 → .NET 503 with correct German message.

## Non-goals

- No frontend (P2-7, P2-8, P2-9).
- No real network calls in tests (mocked HTTP handler).
- No rate-limiting implementation yet (Phase 2 master plan decision #6: 10/h soft, 50/h hard — lands in its own follow-up or gets bolted into P2-5's Hangfire config as a retry/throttle).

## Acceptance criteria

- `dotnet test` green + new integration tests.
- Python `pytest` unchanged.
- Web (548) unchanged.
- All four user-facing endpoints respond correctly in the integration test suite.

## Anti-shortcut reminders

- TDD every endpoint.
- HMAC signer + timestamp rotation must be central (one class), not per-endpoint.
- Photo URL ownership check: prevent a user submitting photos URLs that belong to a different user. Re-use the existing photo HMAC verification.
- 422 from Python on "no recipe detectable" should still return 200 to frontend with the low-confidence result — that's the plan's "let user decide" path, not an error.

## Dispatch notes

**Impl agent:**
- Read P2-5 plan + impl carefully before starting. This slice assumes HMAC signer + `RecipeImport` entity + `ExtractRecipeFromUrlJob` all exist.
- Work order: chat endpoint (simplest, synchronous proxy) → chat-to-recipe → URL import (async) → photo import (async) → error mapping refinements.
- Commit per endpoint.

**Reviewer:**
- Confirm no direct HTTP calls from controllers — everything via `IHttpClientFactory`.
- Confirm HMAC header is generated for every outgoing call.
- Confirm error messages never leak internal exception stack traces.
- Confirm group-membership check is enforced.
