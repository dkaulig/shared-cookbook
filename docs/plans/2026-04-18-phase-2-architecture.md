# Phase 2 — AI-Assistenten · Master Architecture Plan

**Phase:** 2
**Status:** planned (user approval needed before P2-0 dispatch)
**Date:** 2026-04-18
**Depends on:** Phase 1 + Phase 1.5 complete + BF1 + AP1 + GM1 + UX1-RT + UX1-PU landed.
**PRD reference:** `docs/plans/2026-04-17-familien-kochbuch-design.md` §5 (Phase 2 — AI-Assistenten).

## Why a master plan

Phase 2 is big enough that orchestrating it as a single slice would be reckless. This doc is the **architectural contract** — it spells out the full surface area, the service boundaries, the sub-slice decomposition, and the dependencies. Each sub-slice (P2-0…P2-10) gets its own detailed plan doc and its own TDD dispatch when we're ready to start it.

## High-level architecture

Three user-facing AI paths all funnel into the **same review-before-save UX**, so the human stays in the loop. Heavy lifting sits in a new **Python microservice** next to the existing .NET API. The job queue lives in **.NET via Hangfire** so retries, monitoring, and the dashboard land in familiar territory.

```
┌─────────────────┐     ┌─────────────────┐            ┌──────────────────┐
│  React web app  │ ──► │  .NET API       │            │ Python extractor │
│  (unchanged)    │     │  - Hangfire job │ ─────HTTP► │ (FastAPI, sync)  │
│                 │     │  - proxy + auth │ ◄──result─ │ stateless        │
└─────────────────┘     └─────────────────┘            └──────────────────┘
                                  │                               │
                                  │                               ├─► yt-dlp
                                  ▼                               ├─► faster-whisper
                         ┌─────────────────┐                      ├─► recipe-scrapers
                         │  Postgres       │                      ├─► Azure OpenAI
                         │  (app + hangfire│                      └─► SeaweedFS (via .NET proxy)
                         │   schema)       │
                         └─────────────────┘
```

**Design rules**
- API keys for Azure OpenAI live **only** in the Python service. Frontend never sees them. .NET never sees them.
- The .NET API is the single authentication boundary + orchestrator. Hangfire manages jobs (retry policy, dashboard, scheduled retries).
- The Python service is a **stateless synchronous HTTP worker** — it holds no queue, no state. Hangfire calls a Python endpoint and waits (30–120 s for video; 5–15 s for photos).
- Service-to-service auth: HMAC-signed header (`X-Extractor-Signature: HMAC(user_id + timestamp + body-hash, shared-secret)`) → Python verifies. See `EXTRACTOR_SHARED_SECRET` env var.
- No direct browser → Python call. All traffic through .NET.
- The Review UI reuses the existing `RecipeFormPage` (DS6 slice) — Phase 2 pre-fills the form with extracted data rather than introducing a new form.

### Hangfire storage

- **Provider:** `Hangfire.PostgreSql` (MIT-licensed community package, free — unlike the Redis provider which requires Hangfire Pro).
- **Database:** same Postgres instance as the app, dedicated `hangfire` schema. Connection string sets `SearchPath=hangfire,public` so EF Core and Hangfire don't collide.
- **Dashboard:** `/api/hangfire` (behind `RequireAuthorization("Admin")` — admins only). Gives you retry inspection, manual re-enqueue, failure logs.
- **Backup:** covered by the single Postgres dump that already backs up the app data. No separate backup pipeline.

### Whisper model

- **Model:** `large-v3` (≈3 GB download, best accuracy on German speech + noisy audio).
- **Download:** baked into the Python Dockerfile via a build-stage `download_model.py` step so the image is self-sufficient. Pulls from HuggingFace repo `Systran/faster-whisper-large-v3` at build time, not runtime.
- **Image size impact:** Python image grows to ~3.5 GB. Acceptable — the VPS pull runs once per deploy.
- **Run mode:** CPU int8-quantized via CTranslate2 (no GPU on the Hetzner VPS). Rough throughput: 1 min audio → 30–60 s transcription on the VPS's x86 cores.

## Sub-slice decomposition

Slices are ordered by dependency. Each is a stand-alone deliverable with its own tests, its own TDD dispatch, and its own reviewer pass.

### P2-0 — Python service scaffold + Docker + CI

**Goal:** A FastAPI "hello world" container boots inside the compose stack, health-checks cleanly, runs pytest in CI.

- Directory: `apps/python-extractor/`
- `pyproject.toml` (uv or pip-tools) pinning Python 3.13
- FastAPI skeleton with `GET /health`
- `Dockerfile` multi-stage: builder (installs deps + pre-compiles whisper) → runtime
- Compose service wired into `docker-compose.yml` + `docker-compose.prod.yml`
- GitHub Actions `test-python` job added next to `test-api`, `test-web`, `test-shared` (parallel)
- pytest + ruff + mypy baseline

**Est.:** 1–2h. Sets up the service with no business logic.

### P2-1 — LLM provider abstraction

**Goal:** `llm_provider.py` interface + `AzureOpenAIProvider` implementation + mock provider for tests.

- Interface: `extract_structured(messages, schema) -> dict`, `chat(messages) -> str`, `vision_extract(images, prompt) -> dict`
- `AzureOpenAIProvider` uses the Responses API (api-version `2025-04-01-preview`) based on `.env.example` values
- `MockProvider` returns scripted canned responses for tests
- Config via `AZURE_OPENAI_*` env vars (already staged in `.env.example`, see `docs/infra-secrets.md`)
- Retry + timeout + rate-limit backoff via `tenacity`
- Tests cover the mock provider + one integration test against Azure using the user's resource (skipped by default, enabled via `AZURE_OPENAI_INTEGRATION=1`)

**Est.:** 2–3h.

### P2-2 — URL extraction (video + blog unified pipeline)

**Goal:** `POST /extract/url` accepts any URL, returns a structured recipe JSON. Supports Facebook, Instagram Reels, TikTok, YouTube, and plain blog URLs.

- Pipeline per PRD §5.1 steps 1–6:
  1. `yt-dlp` download → mp4 + metadata + caption + description
  2. `faster-whisper` transcript (German model `large-v3` default, `base.de` fallback for speed)
  3. Caption URL extraction (regex + Unshortener) → enriches with blog HTML if present
  4. `recipe-scrapers` + `extruct` JSON-LD first; `beautifulsoup4` fallback
  5. *(P2-2 excludes Vision-LLM overlay extraction — that's Phase 2.1 future-work)*
  6. `llm_provider.extract_structured` combining all sources
- Blog-only URLs skip steps 1 + 2; the rest is identical.
- Endpoint returns `{ job_id }` — the actual extraction runs in the background queue (P2-5). For P2-2 alone we can keep it synchronous while validating the pipeline; P2-5 moves it to background.
- Thumbnail becomes the initial recipe photo (stored in SeaweedFS via the .NET proxy).
- Error handling per PRD §5.1: download-failed, no-recipe-detected, missing-quantities badge markers.
- Tests with fixture videos + fixture HTML.

**Est.:** 4–6h — this is the centrepiece. Heavy, but bounded.

### P2-3 — Photo extraction (paper / screenshot / handwriting)

**Goal:** `POST /extract/photos` accepts ordered image URLs (already uploaded to SeaweedFS), returns a structured recipe.

- Vision-LLM path: `llm_provider.vision_extract(images, prompt)`.
- Handwriting-friendly prompt + language hints.
- Alte Maßeinheiten kept original, offered conversion in review.
- Multi-photo ordered sequence → single recipe.
- Partial-recognition: whatever is readable is extracted, uncertain spans marked with a `confidence: low` flag on the affected ingredient/step.

**Est.:** 2–3h.

### P2-4 — AI Chat

**Goal:** Conversational rezept-erfinden endpoint + session store.

- `POST /chat` with `session_id` + `messages` — stateless from the service's POV; session persisted in Redis with 24h TTL.
- `POST /chat/{session}/to-recipe` — calls structuring LLM with the full chat history + a "convert to recipe" prompt → structured JSON.
- Streaming response (SSE) is v1.1 polish — not in P2-4. Synchronous chat turn is fine; typical response < 5s.
- Tests with `MockProvider` scripted dialogue.

**Est.:** 2–3h.

### P2-5 — Hangfire job orchestration + status API (.NET-side)

**Goal:** All long-running work is a Hangfire job in .NET. Python stays synchronous. Frontend polls via `.NET`.

- Add `Hangfire` + `Hangfire.PostgreSql` NuGet packages.
- Migration: create `hangfire` schema in Postgres; Hangfire creates its own tables idempotently on boot.
- Job types:
  - `ExtractRecipeFromUrlJob(userId, groupId, url)` — calls `POST {PYTHON}/extract/url`, persists result in a new `RecipeImport` entity (Postgres table) with status + result JSON.
  - `ExtractRecipeFromPhotosJob(userId, groupId, photoUrls[])` — same shape.
  - `ChatTurnJob(userId, sessionId, userMessage)` — may be skipped from Hangfire if chat stays synchronous (< 5 s). Decision in P2-4.
- `RecipeImport` entity: `Id`, `UserId`, `GroupId`, `Source` (url/photos/chat), `Status` (queued/running/done/error), `Progress` (0–100), `ResultJson` (nullable), `ErrorMessage` (nullable), `CreatedAt`, `CompletedAt`. EF Core migration.
- Status API: `GET /api/imports/{importId}` returns the current state of `RecipeImport`. Frontend polls every 2 s.
- Retry policy: Hangfire's built-in `AutomaticRetryAttribute` — 3 attempts for transient (5xx, network); `DisableAutomaticRetry` for known hard failures (private video, 4xx from Python).
- Progress updates: the Hangfire job streams progress hints through `Progress` column as it goes (start: 10, video-dl done: 40, transcript done: 70, LLM done: 95, save: 100).
- Dashboard: `/api/hangfire` mounted behind admin-only authorization.
- Tests: integration tests with `Hangfire.InMemory` backend; assert job enqueue, retry, failure paths.

**Est.:** 3–4h (slightly more than the old arq plan, because we also add the `RecipeImport` persistence layer — but Python side becomes simpler).

### P2-6 — .NET ↔ Python bridge endpoints

**Goal:** The frontend never talks to the Python service directly. .NET proxies.

- `POST /api/recipes/import/url` — takes `{ url, groupId }`, forwards to Python `POST /extract/url`, returns `{ importId }`.
- `POST /api/recipes/import/photos` — takes `{ photoUrls[], groupId }`, forwards, returns `{ importId }`.
- `POST /api/chat` — session-scoped chat turn, proxied.
- `GET /api/imports/{importId}` — polls the Python `GET /jobs/{id}`, returns the same shape, respects auth.
- Service-to-service HMAC auth: `.NET` signs `{ user_id + timestamp }` with a shared secret `EXTRACTOR_SHARED_SECRET` (new env var). Python verifies.
- When a job completes, the frontend receives the structured recipe JSON; saving it creates a real recipe via the existing `POST /api/groups/{id}/recipes` endpoint — **no new write path**.
- Tests: integration test covers the full round-trip with a fake Python service.

**Est.:** 3–4h.

### P2-7 — Web UI: URL import flow

- New entry: "+ Rezept aus Video importieren" button on HomePage + GroupDetailPage.
- `/rezepte/import/url` route with: URL input, optional group picker (if >1 group), submit.
- Progress screen: polls `GET /api/imports/{id}` every 2s, shows "Video laden…" / "Transkribieren…" / "Strukturieren…" based on the `progress` field.
- On done: navigate to `/rezepte/neu?importId=…` — RecipeFormPage pre-fills from the extracted JSON.
- User edits, reviews missing-quantities flags, saves → existing S4 create-recipe flow.
- Tests with MSW mocking the import endpoint.

**Est.:** 2–3h.

### P2-8 — Web UI: Photo import flow

- Entry: "+ Rezept aus Foto importieren".
- Multi-photo upload (drag-drop + mobile camera).
- Upload photos to SeaweedFS first (existing flow) → trigger import with the uploaded URLs.
- Progress + review + save — identical to P2-7.

**Est.:** 2h.

### P2-9 — Web UI: AI Chat

- `/chat` route behind auth.
- Message list, text input, send.
- "In Rezept umwandeln" button → calls `POST /api/chat/:session/to-recipe` → same review flow.

**Est.:** 2–3h.

### P2-10 — Nutrition estimation

- Extend the structuring prompt (P2-2 + P2-3 + P2-4→recipe) to also produce per-portion estimates: `{ kcal, protein_g, carbs_g, fat_g }`.
- DB migration: add `NutritionEstimate JSONB` column on `Recipes` table.
- UI: small "Geschätzt" chip next to the values on the recipe detail; manual override input.
- Tests: migration test + UI display test.

**Est.:** 1–2h.

## Total scope

~22–30h of agent time across 11 sub-slices. Realistic elapsed orchestrator time: 3–5 days depending on how aggressively we parallelize independent slices (P2-7, P2-8, P2-9 can run in parallel once P2-6 is green).

## Hard dependencies

- **P2-0 blocks everything** — service must exist first.
- **P2-1 blocks P2-2, P2-3, P2-4** — all need the LLM interface.
- **P2-5 blocks P2-6** — background jobs before proxy.
- **P2-6 blocks P2-7, P2-8, P2-9** — frontend needs the bridge.
- **P2-10 depends on P2-2** — extends the same prompt.

**Parallelization opportunity:** after P2-6 lands, P2-7, P2-8, P2-9 can go as three independent parallel agents. Each is bounded in scope, touches different web routes.

## Non-goals (explicit, match PRD §5.7)

- Direct video-file upload (only URLs; photos ARE supported — P2-3).
- Voice input in chat.
- Self-hosting LLMs (Whisper runs locally, the rest goes to Azure).
- Real-time collaboration on the review screen.
- Mobile-native app (PWA is sufficient).

## Open architectural questions (user input needed before P2-0 dispatch)

1. **arq vs RQ vs Celery for the background queue.** Recommendation: **arq** — fits asyncio, tiny API, no separate worker process management headaches. RQ requires sync handlers. Celery is industrial-scale overkill.

2. **faster-whisper model size.** `large-v3` is accurate but hungry (~2GB VRAM / CPU is slow). `base.de` is 10× faster but misses detail. Recommendation: start with `base.de`, upgrade if transcript quality disappoints on the fixture videos.

3. **Service-to-service auth: HMAC vs mTLS vs shared secret header.** Recommendation: **HMAC-signed header** — simplest, no cert rotation, scoped to internal docker network so threat model is low.

4. **Azure OpenAI error handling when Azure is down.** Recommendation: hard-fail the job with a "KI-Service momentan nicht erreichbar, bitte später erneut versuchen" message. No local fallback model in v1.

5. **Cost visibility.** Should we surface per-import cost estimates in the UI or track them server-side only for the admin? Recommendation: server-side only (a simple `NutritionEstimate`-style JSON field on the `RecipeImport` record). Phase 3 can add a "your account used ~2€ this month" panel if it becomes relevant.

6. **Quota / rate-limiting.** How many imports per user per hour before we throttle? Recommendation: soft limit 10/hour, hard limit 50/hour, per-user. Configurable per env var.

Answer these six questions and I'll write the P2-0 plan doc.

## Acceptance criteria (for Phase 2 overall, checked at the end of P2-10)

- All ten sub-slices shipped with green tests + green `pnpm build` + green `dotnet test` + green `pytest`.
- A user can: import a video URL → get an editable recipe → save. Import photos → get an editable recipe → save. Chat → turn chat into a recipe → save. See nutrition estimates on a recipe.
- No secrets in git. No secrets in frontend. No secrets in .NET.
- Redis queue survives restarts (jobs persist).
- Docker compose stack on VPS: 7 services (postgres, redis, seaweedfs, api, web, caddy, python-extractor) all healthy after `docker compose pull && up -d`.

## Open follow-ups (deferred, not Phase 2)

- Vision-LLM overlay extraction from key video frames (Phase 2.1).
- Audio-only recipe extraction (user describes what they cooked).
- Multi-recipe batch import (playlist URL → N recipes).
- Cost-per-import telemetry dashboard.
- Provider switch to OpenAI-direct or Gemini via `LLM_PROVIDER` env var (the abstraction supports it, we just haven't implemented the alternates).
