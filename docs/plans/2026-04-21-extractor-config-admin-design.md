# Extractor Config externalised to DB + Admin UI (CFG)

**Date:** 2026-04-21
**Status:** ✅ Designed autonomously, ready to dispatch
**Bundle tag:** `v0.11.0` after all three slices + local E2E gate green.

## Why

Every Python-extractor change (prompt tweak, temperature, model swap,
feature kill-switch) today forces a full rebuild + push of a ~2-3 GB
Docker image + a full deploy. Today's COMP-FIX alone cost ~10 minutes
of CI time for a few-line change. At our iteration speed this adds up
fast, and we lose the ability to hotfix (e.g. disable video-import
when yt-dlp breaks, swap to cheaper model when Azure bills spike,
patch a prompt when the LLM flakes).

Fix: move the **hot-configurable knobs** into a DB-backed admin surface
so prompt / temperature / feature-flag changes land in seconds instead
of ten minutes. Schema / SSRF guards / dependency versions stay in
code (Git-review-pflichtig, security-relevant).

## Decisions (all locked autonomously per delegation)

| # | Question | Pick |
|---|----------|------|
| 1 | Storage | Single `ExtractorConfig` table in the main Postgres, keyed by dotted string. History table for audit. |
| 2 | Value encoding | `ValueJson` (jsonb) + `ValueType` enum (`string` / `int` / `float` / `bool` / `string_list`). Backend validates per-key on write. |
| 3 | Fallback | Hardcoded defaults stay in code as the "ground truth". DB values OVERRIDE. If fetch fails, extractor uses defaults. |
| 4 | Fetch model | Python extractor pulls on startup + refreshes every 60 s via `GET /api/internal/extractor-config`. Internal-only (docker-network scoped, `InternalOnlyMiddleware`). |
| 5 | Admin API | `GET /api/admin/extractor-config` + `PUT /api/admin/extractor-config/{key}`. Admin-role gate. |
| 6 | Admin UI | New React page at `/admin/extractor`. Single form, sections (Prompts / Feature-Flags / Thresholds). Inline edit, save-per-key, optimistic + rollback on 4xx. |
| 7 | Audit | Separate `ExtractorConfigHistory` rows on every update (Key, OldValue, NewValue, UpdatedAt, UpdatedBy). "Letzte Änderungen"-section in admin UI. |
| 8 | Reproducibility | Each `RecipeImport.ResultJson` gains a `config_snapshot` field with the prompt-version + model + temperature + max_tokens used for that extraction. |
| 9 | Delivery | CFG-0 Backend + CFG-1 Python in parallel, then CFG-2 Admin UI. Tag v0.11.0 after CFG-2 + local E2E-gate. |

Deliberately NOT externalised (stays in code, version-controlled):
- JSON schema for LLM output (cross-stack contract).
- SSRF guard values (private-IP ranges, `_BLOCKED_HOSTNAMES`).
- `ThumbnailAttacher.AllowedHostSuffixes` (security-critical).
- yt-dlp / faster-whisper / SDK versions.
- Whisper model name / size (would also need pre-cached weights in
  image — follow-up slice if needed).

## Config keys — v1 scope

### Structured extraction (gpt-4.1-mini Responses API)
- `llm.structured.system_prompt` — string, default = today's `SYSTEM_PROMPT_DE`
- `llm.structured.temperature` — float (0..2), default 0
- `llm.structured.max_completion_tokens` — int (100..8192), default 2048
- `llm.structured.deployment` — string, default "gpt-4.1-mini"

### Chat (gpt-5.1-chat)
- `llm.chat.system_prompt` — string, default = today's chat system prompt
- `llm.chat.max_completion_tokens` — int (100..8192), default 2048
- `llm.chat.deployment` — string, default "gpt-5.1-chat"
- (no temperature — chat model rejects non-default)

### Vision (photo import)
- `llm.vision.system_prompt` — string
- `llm.vision.temperature` — float (0..2), default 0
- `llm.vision.deployment` — string
- `llm.vision.max_completion_tokens` — int

### Feature flags (kill switches)
- `feature.video_import_enabled` — bool, default true
- `feature.blog_follow_enabled` — bool, default true
- `feature.nutrition_estimate_enabled` — bool, default true
- `feature.thumbnail_auto_attach_enabled` — bool, default true
- `feature.chat_enabled` — bool, default true

### Pipeline thresholds
- `pipeline.min_transcript_chars` — int (1..10000), default 20
- `pipeline.component_label_max` — int (1..200), default 50
- `pipeline.generic_label_blacklist` — string_list, default = COMP-FIX's 7 entries
- `pipeline.shortener_hosts` — string_list, default = today's 8 entries
- `pipeline.shortener_max_redirects` — int (0..10), default 3
- `pipeline.shortener_head_timeout_seconds` — float (0.5..30), default 5.0

## Data model

### `ExtractorConfig`
- `Key: string` (PK, dotted, ≤ 100 chars)
- `ValueJson: jsonb` (stringified; backend validates per-key before write)
- `ValueType: enum { string, int, float, bool, string_list }`
- `UpdatedAt: timestamptz`
- `UpdatedBy: Guid?` (NULL for migration-seed rows, UserId for admin edits)
- `Version: int` (increments on every update; used by optimistic-concurrency guard in admin UI)

### `ExtractorConfigHistory`
- `Id: Guid`
- `Key: string`
- `OldValue: jsonb`
- `NewValue: jsonb`
- `ChangedAt: timestamptz`
- `ChangedBy: Guid?`

Indexed `(Key, ChangedAt DESC)` for the admin UI's per-key history view.

## Backend API

### Admin (authenticated, Role=Admin)
- `GET /api/admin/extractor-config` → full list, ordered by Key.
- `GET /api/admin/extractor-config/{key}` → single row + last-10 history entries.
- `PUT /api/admin/extractor-config/{key}` body `{ value, expectedVersion }` → validates per-key (value range / length / regex for deployment name), writes history row + bumps Version. 409 on version mismatch.
- `POST /api/admin/extractor-config/{key}/reset` → resets to hardcoded default, writes history row.

### Internal (docker-network only, `InternalOnlyMiddleware`)
- `GET /api/internal/extractor-config` → full list, no auth (internal trust).

Both endpoints return the same DTO:
```json
{
  "items": [
    {"key": "llm.structured.temperature", "value": 0.0, "type": "float", "updatedAt": "...", "updatedBy": {"id":"...","displayName":"Admin"}, "version": 3},
    ...
  ]
}
```

## Python config-loader

New module `apps/python-extractor/src/extractor/config_loader.py`:

```python
class ExtractorConfig:
    """TTL-cached client for the .NET API's /internal/extractor-config."""

    def __init__(self, api_base: str, ttl_seconds: float = 60.0) -> None:
        self._api_base = api_base
        self._ttl = ttl_seconds
        self._cache: dict[str, Any] = {}
        self._cache_expires_at: float = 0
        self._lock = asyncio.Lock()

    async def get(self, key: str, default: T) -> T:
        async with self._lock:
            if time.monotonic() >= self._cache_expires_at:
                await self._refresh()
        return self._cache.get(key, default)

    async def _refresh(self) -> None:
        # httpx GET /api/internal/extractor-config, populate cache, 
        # update _cache_expires_at. On failure, keep stale cache +
        # log WARN. Never raise — defaults fall through.
```

All hardcoded constants in `pipeline/url.py`, `prompts/recipe_
extraction.py`, `llm/azure_openai.py` get replaced with `await
config.get("pipeline.min_transcript_chars", 20)` etc. Defaults stay
in code as the second arg to `.get()`.

## Admin UI

New page `/admin/extractor` — `apps/web/src/features/admin/ExtractorConfigPage.tsx`.

Sections:
1. **Prompts** — big textareas for the 3 system prompts (Structured, Chat, Vision). Character counter. "Zurücksetzen"-Button per prompt to reset to code default.
2. **Modelle & Parameter** — Model-Deployment + Temperature + Max-Tokens per call type.
3. **Feature-Flags** — 5 Switch toggles.
4. **Thresholds** — number inputs + string_list chip editor for blacklists.

Save is per-field: user edits one field, presses save (or auto-save on blur for typed values). UI shows a "Gespeichert vor X Sekunden" indicator + last-editor chip.

Admin-history section at the bottom: last 20 changes across all keys, filterable.

Protected route: `<AdminRoute>` (new or existing) that redirects non-admins to `/`.

## Reproducibility

Every structured-extraction call now records a `config_snapshot` in
its `ResultJson`:
```json
{
  "recipe": {...},
  "confidence": {...},
  "signals": {...},
  "config_snapshot": {
    "prompt_hash": "sha256:...",
    "temperature": 0,
    "max_completion_tokens": 2048,
    "deployment": "gpt-4.1-mini",
    "prompt_version": 7
  }
}
```

So when debugging a bad extraction, one can see exactly which prompt
version + params were active. `prompt_version` is the `Version` column
of the prompt's config row.

## Validation rules (backend per-key)

| Key | Rule |
|-----|------|
| `llm.*.system_prompt` | 100 ≤ len ≤ 20000 chars |
| `llm.*.temperature` | 0 ≤ x ≤ 2 |
| `llm.*.max_completion_tokens` | 100 ≤ x ≤ 8192 |
| `llm.*.deployment` | regex `^[a-z0-9][a-z0-9-._]{1,63}$` |
| `feature.*` | bool |
| `pipeline.min_transcript_chars` | 1 ≤ x ≤ 10000 |
| `pipeline.component_label_max` | 1 ≤ x ≤ 200 |
| `pipeline.*_hosts` / `pipeline.*_blacklist` | each item 1-100 chars, total ≤ 50 items |
| `pipeline.*_timeout_seconds` | 0.5 ≤ x ≤ 30 |
| `pipeline.*_max_redirects` | 0 ≤ x ≤ 10 |

Invalid PUT → 400 with `{ "code": "invalid_value", "message": "<German>" }`.

## Migration

EF-Core `AddExtractorConfig`:
- Create `ExtractorConfig` + `ExtractorConfigHistory` tables.
- Seed rows for every key listed above, `UpdatedBy = NULL`, `Version = 0`.
- Seed values match the current hardcoded Python defaults exactly
  (so turning on CFG is a no-op at v0.11.0 boot).

## Feature-flag gating

In the python extractor, each feature-gated pipeline phase reads the
flag at entry:
- Video-import: if `feature.video_import_enabled == false` → return
  `ExtractionError("feature_disabled", "Video-Import ist aktuell
  deaktiviert.")` — .NET maps to HTTP 422 with that German message.
- Blog-follow: if disabled, skip the blog-URL-follow branch even when
  a caption URL is present.
- Nutrition: if disabled, post-process sets `nutrition_estimate` to
  `null` regardless of what Azure returned.
- Thumbnail-attach: if disabled, skip `TryAttachAsync` call (this flag
  lives on the .NET side).
- Chat: if disabled, `POST /api/chat/sessions/{id}/turn` returns 503
  with German message before touching Azure.

## TDD per layer

### CFG-0 Backend
- Entity + EF config tests.
- Migration test (pre-CFG DB → apply → assert every key is seeded with
  the expected default).
- Endpoint tests: admin can GET/PUT/RESET; non-admin 403; internal API
  requires internal-middleware; validation rejects out-of-range values
  per key; history row written on every successful PUT; optimistic-
  concurrency 409 when `expectedVersion` stale.

### CFG-1 Python
- `config_loader.py`: TTL cache, fetch, fallback-on-error, race safety.
- Every hardcoded-constant replacement has a test proving the value
  now flows through `config.get()`.
- `post_process.py` + `url.py` + `azure_openai.py` updated paths + tests.
- Feature-flag gating: each of the 5 flags has a test proving the
  pipeline behaves correctly when the flag is false.

### CFG-2 Frontend
- Admin route gate.
- Per-section render + per-field save + optimistic update + rollback
  on 409/400.
- History section rendering.

### Local E2E gate (before tag)

Written as `apps/web/e2e/extractor-config-admin.spec.ts` (credentials-
gated skip-clean, not run in CI):

1. Admin logs in, navigates to `/admin/extractor`.
2. Changes `llm.structured.temperature` from 0 to 0.5 → asserts success
   toast + last-edited chip.
3. Manually triggers a re-cache on the extractor (via a debug endpoint
   `POST /api/internal/extractor-config/refresh`), or waits for the 60 s
   TTL.
4. Triggers a recipe import → asserts `ResultJson.config_snapshot.
   temperature === 0.5`.
5. Flips `feature.video_import_enabled` to false → triggers video
   import → asserts HTTP 422 with the "aktuell deaktiviert" German
   message.
6. Flips flag back to true → import works again.

These are the hard gates before v0.11.0 tag. Each must pass locally.

## Delivery

**Round 1 (parallel, file-disjoint):**
- **CFG-0 Backend** — entity, migration, endpoints, validation, history,
  domain tests, endpoint tests.
- **CFG-1 Python** — config_loader, replace constants, feature-flag
  gating, tests.

**Round 2 (serial):**
- **CFG-2 Admin UI** — extractor-config page, per-section form, history
  view.

**Round 3 (local-only):**
- Full docker rebuild + recreate. Walk the 6-step E2E gate above. Only
  if all 6 pass → tag `v0.11.0` + push.

## Scope cuts / follow-ups

- Whisper-model-size hot-swap (needs pre-cached weights, tricky image
  layer).
- JSON schema hot-editable (cross-stack contract, don't open that door).
- SSRF / allowed-host lists hot-editable (security, keep in code).
- A/B-test prompt variants (would need traffic-split routing — later
  slice).
- Real-time config-change broadcasting via SignalR (60 s TTL is fine
  for now; can swap to push later).
