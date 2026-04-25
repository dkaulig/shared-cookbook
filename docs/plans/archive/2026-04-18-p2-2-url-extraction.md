# P2-2 — URL Extraction (video + blog unified pipeline)

**Slice:** P2-2
**Status:** planned
**Date:** 2026-04-18
**Depends on:** P2-0 (scaffold) + P2-1 (LLM provider).
**Parent plan:** `docs/plans/2026-04-18-phase-2-architecture.md`.

## Why

The centrepiece of Phase 2. Accepts any URL (Facebook Reel, Instagram, TikTok, YouTube, plain blog), produces a structured recipe JSON. Covers the user's flagship "paste link, get recipe" flow.

## Scope

### 1. Endpoint

`POST /extract/url`

Request body:
```json
{
  "url": "https://…",
  "hint": { "group_id": "...", "user_id": "..." }
}
```

`hint` is metadata the caller provides — the service doesn't use it for logic, just echoes it into result metadata so the orchestrator can correlate (Hangfire in P2-5 will carry `groupId` / `userId` through).

Response (synchronous for now; P2-5 moves it behind Hangfire):
```json
{
  "recipe": {
    "title": "...",
    "description": "...",
    "servings": 4,
    "difficulty": 2,
    "prep_minutes": 10,
    "cook_minutes": 30,
    "ingredients": [
      { "name": "...", "quantity": "250", "unit": "g", "note": null, "confidence": "high" | "low" | "missing" }
    ],
    "steps": [
      { "position": 1, "content": "...", "confidence": "high" | "low" }
    ],
    "tags": ["warm", "vegetarian", "abend"],
    "source_url": "https://…",
    "thumbnail_url": "https://…"
  },
  "confidence": { "overall": "high" | "medium" | "low", "notes": [...] }
}
```

Ingredients with no quantity get `confidence: "missing"` so the frontend highlights them for review.

### 2. Pipeline stages (per PRD §5.1)

File: `apps/python-extractor/src/extractor/pipeline/url.py`

```python
async def extract_from_url(url: str, provider: LLMProvider) -> ExtractionResult:
    ...
```

Internally:

1. **Resolve + classify**: HEAD request; if `Content-Type` is text/html → blog path; if it's a known video-host domain → video path. Redirects followed.
2. **Video path** (Facebook, Instagram, TikTok, YouTube):
   - `yt-dlp` download → mp4 + metadata (title, description, uploader, thumbnail URL).
   - **Caption URL extraction**: regex over description for http(s)://… → unshorten → fetch as HTML → apply blog path 2.
   - **Transcript**: `faster-whisper large-v3` CPU int8 int8_int8 on the downloaded audio. Writes to temp dir, clean up after.
3. **Blog path**:
   - `httpx` GET with UA string + timeout.
   - `extruct` for JSON-LD `Recipe` schema. If present → high-quality structured input for the LLM (often no LLM needed, but we still pass through LLM for normalization to our schema).
   - Fallback: `recipe-scrapers` library (supports 1000+ sites; handles non-JSON-LD markup).
   - Final fallback: `BeautifulSoup` extract of `<article>`/`<main>`/`<body>` text.
4. **LLM structuring** (always runs, even on clean JSON-LD input):
   - Build a combined system prompt + user message with all sources: video transcript, caption, blog HTML text, thumbnail URL.
   - Call `provider.extract_structured(..., json_schema=RECIPE_SCHEMA)`.
   - `RECIPE_SCHEMA` enforces the response shape; the LLM's structured-output mode handles it.
5. **Post-process**:
   - Flag missing quantities: each ingredient without `quantity` gets `confidence="missing"`.
   - Clamp `servings` to 1..20 (defensive).
   - De-dupe tags, lowercase them.
   - Set `source_url` = original caller-supplied URL.
   - `thumbnail_url` = yt-dlp's `thumbnail` or the blog's `og:image`.

### 3. New dependencies (runtime)

Added to `apps/python-extractor/pyproject.toml`:
- `yt-dlp` (pinned)
- `faster-whisper` (pinned)
- `ctranslate2` (faster-whisper runtime)
- `httpx` (already in P2-1 as runtime)
- `extruct`
- `recipe-scrapers`
- `beautifulsoup4`
- `lxml` (HTML parser backend)

**Image size impact:** ~3.5 GB total after `large-v3` model bakes in.

### 4. Whisper model in Docker

Dockerfile build-stage:
```dockerfile
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('large-v3', device='cpu', compute_type='int8')"
```

This pulls the model from HuggingFace into the image's `~/.cache/huggingface/` at build time. Runtime never downloads.

### 5. Prompt library

File: `apps/python-extractor/src/extractor/prompts/recipe_extraction.py`

Contains:
- `SYSTEM_PROMPT_DE`: role + output-schema hints, German-first but works on multi-language content.
- `build_user_message(transcript, caption, blog_text, thumbnail)`: assembles the context.
- `RECIPE_SCHEMA`: JSON schema for the structured response. Enforces required fields, types, length limits (title ≤ 200 chars, steps ≤ 30, etc.).

### 6. Error handling (per PRD §5.1 + Phase 2 master §open-question #4)

- **Download fails** (403/404/private video) → raise `ExtractionError("source_unavailable", "Das Video ist nicht verfügbar — vielleicht privat gelöscht oder gelöscht?")`.
- **No recipe detectable** → return result with `confidence.overall="low"` + `notes: ["Kein Rezept eindeutig erkennbar"]`. Don't error out; let the user decide.
- **Blog fetch fails** (403, 404, timeout) — fall back to video-only sources; add note "Website nicht erreichbar".
- **Azure outage** → `LLMProviderError(code="provider_unavailable")` propagates → caller returns HTTP 503 with German message "KI-Service momentan nicht erreichbar".

### 7. Tests

Always-on:
- `test_blog_jsonld.py` — fixture HTML with `Recipe` JSON-LD schema, assert structured extraction.
- `test_blog_recipe_scrapers.py` — fixture HTML that recipe-scrapers handles, assert extraction.
- `test_blog_fallback.py` — fixture HTML with no structured data, assert BeautifulSoup extraction.
- `test_pipeline_missing_quantity.py` — LLM (mock) returns ingredients without quantity → `confidence="missing"` flag.
- `test_pipeline_azure_outage.py` — mock provider raises, pipeline surfaces 503.
- `test_pipeline_private_video.py` — yt-dlp mock raises 403, pipeline surfaces `source_unavailable`.
- `test_post_process.py` — clamping, de-dup, tag lowercase, URL preservation.

Skipped-by-default integration:
- `test_youtube_short.py` (gated behind `EXTRACTOR_LIVE_DOWNLOAD=1`) — exercises the real yt-dlp + Whisper path against a small public YouTube clip. Not in CI.

### 8. Performance notes

- Whisper `large-v3` at int8 on CPU: ~0.3× real-time (a 60s video takes ~3 min to transcribe). Acceptable for 30–120s videos.
- yt-dlp download: bandwidth-limited; typically 5–15s for a Reel.
- LLM call: 2–10s.
- Total expected: 30–120s per request. Matches PRD §5.1 user expectation.

## Non-goals

- No Vision-LLM text-overlay extraction from video frames (PRD §5.1 step 5 marked "Phase 2.1 optional").
- No background job queue (P2-5).
- No persistence (P2-5 introduces `RecipeImport` entity on the .NET side).
- No .NET integration (P2-6).
- No frontend (P2-7).

## Acceptance criteria

- `pytest` green including ~15 new tests.
- `ruff check` / `ruff format --check` / `mypy --strict` clean.
- Docker image builds (size ~3.5 GB expected, document if over).
- Web (548) + .NET (474) + shared (32) unchanged.
- Integration test (`EXTRACTOR_LIVE_DOWNLOAD=1 pytest`) passes when run manually.

## Anti-shortcut reminders

- TDD every logic step.
- No `# type: ignore` without a named reason.
- Do NOT catch `Exception` broadly — only the specific `HTTPError`, `ExtractionError`, `LLMProviderError` classes.
- Do NOT log the raw LLM response at `INFO` — user content, not needed beyond debug.
- Do NOT leak temp files. Use `tempfile.TemporaryDirectory()` + context managers.
- Do NOT make the always-on tests network-dependent. Everything uses fixtures (local HTML files, mocked yt-dlp + whisper + LLM).

## Dispatch notes

**Impl agent:**
- Read plan + parent plan + P2-1 provider interface first.
- Work order: blog path (easiest, pure HTML parsing) → post-processing → video path with mocked yt-dlp + mocked Whisper → LLM structuring glue → error paths → integration smoke.
- Commit per step. TDD pairs.
- Run gates after each chunk: `pytest`, `ruff`, `mypy`, `docker build`.
- Final: all four language gates (.NET / web / shared / python).

**Reviewer:**
- Confirm NO live network calls in the always-on tests.
- Confirm temp-file cleanup via context managers.
- Confirm no broad `except Exception`.
- Confirm the Whisper model is baked into the Docker image (not downloaded at runtime).
- Spot-check prompt library for API-key leakage risk (should be just system prompts + schema).
