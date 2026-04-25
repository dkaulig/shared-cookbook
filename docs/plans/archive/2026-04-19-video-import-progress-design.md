# Video-Import Progress Tracking — Design

**Status:** approved 2026-04-19 (user + orchestrator)
**Scope:** URL + Photo import flows (Chat intentionally excluded — synchronous, short).
**Deploy:** single `v0.4.0` tag with both images atomic-swap.

## Why

Current UX: `Queued (0%) → Running (10%) → Done (100%)`. The 10% state
persists for 1-3 minutes while `yt-dlp` downloads, `faster-whisper` transcribes,
and Azure OpenAI structures — user sees a frozen progress bar with no phase
information and no ETA. Live E2E smoke against prod confirmed the problem.

## Target UX

Phasen-bewusster Fortschritt mit echten Prozentzahlen:

```
Warteschlange (0-5%)
  → Video-Download (5-15%)       "3,4 von 12,7 MB (23%)"
  → Transkription (15-85%)        "Segment 13 von 20 — noch ~45s"
  → Strukturierung (85-95%)       "Rezept wird strukturiert..."
  → Nachverarbeitung (95-100%)   "Nachverarbeitung..."
Fertig (100%)
```

Photo-Import kriegt eigene Phase `VisionAnalysis` (single-shot Azure call,
keine Granularität in-flight).

Retries sichtbar: `"Erneuter Versuch 2/3 — Video wird heruntergeladen..."`.

## Architecture

```
User clicks "Importieren"
    ↓
.NET: RecipeImport row + Hangfire job → 202 {importId}
    ↓
Frontend: /imports/{id} ImportProgressPage
    ↓
Frontend: useLiveSync subscribes to SignalR (P3-8, already live)
          + polls GET /api/imports/{id} every 3s fallback
    ↓
Hangfire worker: PythonExtractorRunner
    - generates callback_url + HMAC-signed per-import token
    - POST /extract/url to Python with { …, callback_url, callback_token, import_id, attempt }
    ↓
Python pipeline (yt-dlp + Whisper + Azure):
    - ProgressReporter throttles 500ms, sends HMAC-POST
      to callback_url on phase transitions + periodic within-phase
    - Fire-and-forget: callback failures do NOT abort extraction
    ↓
.NET POST /api/internal/imports/{id}/progress:
    - validates HMAC token (per-import, 10min expiry)
    - import.UpdateProgress(phase, phaseProgress, bytes?, segments?, now)
    - publishes RecipeImportProgressChanged via LiveSyncPublisher
      → SignalR group:{groupId}
    ↓
Frontend: setQueryData on receive (authoritative payload, no refetch)
          Polling takes over within 3s if SignalR disconnected
    ↓
Python returns final result synchronously → .NET stores recipe,
    import.UpdateProgress(Done, 100) + publish final event
```

**Key design anchor:** Python's `/extract/url` stays a synchronous HTTP responder
for the final result. Only progress updates become async callbacks. This keeps
the existing contract mostly intact — E2E-tested flows remain unchanged except
at the Python outgoing-callback layer.

## Phase-Weighted Progress Formula

```
Queued          → 0-5%    (5%)
Downloading     → 5-15%   (10%)
Transcribing    → 15-85%  (70%)  ← longest phase by wall-clock
Structuring     → 85-95%  (10%)
PostProcessing  → 95-100% (5%)

Photo-path:
Queued          → 0-5%
VisionAnalysis  → 5-95%   (90%)
PostProcessing  → 95-100%

Global progress = phase_start + phase_progress% * phase_range
```

Gewichte basieren auf typischem FB-Reel (~12 MB video, ~60-120s audio,
gpt-4.1-mini ~3s). Später feintunbar wenn AI-usage-Daten zeigen dass
Annahmen daneben liegen.

## Current Baseline (verified 2026-04-19)

Design-review pass against actual code found:
- `RecipeImport` entity currently has ONLY `Progress: int` field (no
  `ProgressLabel` — that's derived client-side from `progress` in
  `progressLabel.ts` today). PV1 adds `Phase`, `PhaseProgress`, `BytesDownloaded`,
  `BytesTotal`, `SegmentsDone`, `SegmentsTotal`, `AttemptNumber`, `LastProgressAt`,
  AND a new stored `ProgressLabel: string?` so the server computes German
  copy (client helper becomes obsolete).
- Python `ExtractUrlRequest` pydantic model currently has `url: HttpUrl` +
  `hint: ExtractHint`. New `callback_url` / `callback_token` / `import_id` /
  `attempt` fields are added as OPTIONAL with defaults → backward-compat for
  tests + local direct-Python usage. Note: photos-request uses
  `extra: "forbid"` so the new fields must be added to the pydantic model
  BEFORE any client sends them (impl concern, not design concern).
- `LiveSyncPublisher` interface has 3 methods today (MealPlanSlot, MealPlan,
  ShoppingListItem). PV1 adds a 4th: `RecipeImportProgressChangedAsync`.
- Latest deployed tag: `v0.3.8` (verified no pending main commits).

## Schema — `RecipeImport` Entity Extensions

```csharp
public enum RecipeImportPhase {
    Queued = 0, Downloading = 1, Transcribing = 2,
    Structuring = 3, PostProcessing = 4, VisionAnalysis = 5,
    Done = 6, Error = 7,
}

// New fields on RecipeImport:
public RecipeImportPhase Phase { get; private set; } = Queued;
public int PhaseProgress { get; private set; }  // 0-100 within-phase
public long? BytesDownloaded { get; private set; }
public long? BytesTotal { get; private set; }
public int? SegmentsDone { get; private set; }
public int? SegmentsTotal { get; private set; }
public int AttemptNumber { get; private set; } = 1;
public DateTimeOffset LastProgressAt { get; private set; }
```

Migration `AddRecipeImportPhaseProgress` — nullable/defaulted columns,
no backfill needed.

Domain method `UpdateProgress(phase, phaseProgress, bytes?, segments?, now)`:
- Out-of-order guard: reject if `new.phase < current.phase`, or same phase
  with `new.phaseProgress < current.phaseProgress`. Logged DEBUG, silently
  discarded.
- Retry guard: `new.attempt >= current.attempt`. Stale-attempt callbacks
  discarded.
- Invalid transitions throw (e.g. Done → anything).
- Auto-derives German `ProgressLabel` from phase + optional detail.

## Internal Endpoint

```
POST /api/internal/imports/{importId}/progress
Authorization: Bearer <per-import HMAC token>
Content-Type: application/json

Body:
{
  phase: "downloading" | "transcribing" | "structuring"
       | "post_processing" | "vision_analysis",
  phase_progress: 0-100,
  bytes_done?: number, bytes_total?: number,
  segments_done?: number, segments_total?: number,
  attempt: 1-3
}

Responses:
  204 — updated successfully
  401 — bad or expired HMAC token
  404 — importId unknown
  422 — invalid phase value or out-of-range data
  429 — rate-limit (500/min per importId)
```

**HMAC token:** new per-import pattern. Payload `{importId, expiresAt=now+10min}`
signed with existing `EXTRACTOR_SHARED_SECRET`. Prevents cross-import tampering.

**Network boundary:** Current `infra/Caddyfile` + `Caddyfile.prod` route ALL
`/api/*` upstream without path filtering. **PV1 MUST update Caddy** to deny
`/api/internal/*` from external origins. Two layered defenses:
1. Caddy `@internal path /api/internal/*` matcher → `respond 404` before
   reverse_proxy (both Caddyfile + Caddyfile.prod).
2. App-level middleware on `/api/internal/*` routes: reject if request does
   NOT originate from internal docker network (check `RemoteIpAddress`
   against the docker bridge subnet or a simple allowlist of the container
   network CIDR).
Both layers fail-closed — remove one and the endpoint is still protected.

## SignalR Event

```csharp
// LiveSyncEvents.cs
public static readonly string RecipeImportProgressChanged = "RecipeImportProgressChanged";

// LiveSyncPayloads.cs
public sealed record RecipeImportProgressPayload(
    Guid ImportId, Guid GroupId,
    string Phase, int Progress, int PhaseProgress,
    string ProgressLabel, int AttemptNumber,
    long? BytesDownloaded, long? BytesTotal,
    int? SegmentsDone, int? SegmentsTotal);
```

Publisher: `RecipeImportProgressChangedAsync(import, ct)` — sends to
`group:{import.GroupId}`.

Frontend `useLiveSync` receives → `queryClient.setQueryData(['import', id], payload)`.
**Never invalidateQueries** — the event IS the authoritative state.
Invalidating would cause 500ms-interval GET refetches.

## Python-Side Changes

### Request-body extensions (`/extract/url`, `/extract/photos`)

```python
callback_url: str | None
callback_token: str | None
import_id: str | None
attempt: int = 1
```

Missing fields → reporter is no-op, backward-compatible with tests + local
usage.

### ProgressReporter (new)

```python
# apps/python-extractor/src/extractor/progress.py
class ProgressReporter:
    def __init__(self, callback_url, callback_token, attempt, throttle_ms=500): ...
    async def report(self, phase, phase_progress, bytes_done=None, ...): ...
    async def flush(self): ...  # phase-transition immediate send
```

- Throttle: max one POST / 500ms except on phase transitions (immediate).
- Fire-and-forget: 2s httpx timeout, catches all exceptions → WARNING log.
- No-op when callback_url is None.

### Pipeline integration

- `YtDlpDownloader` accepts `on_progress: Callable[[int, int], None]` →
  yt-dlp `progress_hooks`.
- `FasterWhisperTranscriber` accepts `on_segment: Callable[[int, int], None]`
  → iterate segments, call after each.
- `_run_video_path` + `_run_blog_path` + `photo.extract_from_photos` accept
  `reporter: ProgressReporter | NullProgressReporter` param.

## Frontend Components

```tsx
<ImportProgressPage>
  <OverallProgressBar value={progress} />
  <PhaseStepper currentPhase={phase} />       // 5-step visual, mobile: collapsed text
  <PhaseDetailCard phase={phase} payload={...} />
  <RetryIndicator attemptNumber={attempt} />  // only if > 1
</ImportProgressPage>
```

### PhaseDetailCard content per phase

| Phase | Primary text | Sub-line |
|---|---|---|
| Queued | "Warteschlange — gleich geht's los..." | spinner |
| Downloading | "Video wird heruntergeladen" | "3,4 von 12,7 MB (23%)" |
| Transcribing | "Audio wird transkribiert" | "Segment 13 von 20 — noch ~45s" (ETA only if segments_done > 2) |
| Structuring | "Rezept wird strukturiert (Azure OpenAI)" | indeterminate spinner |
| PostProcessing | "Nachverarbeitung..." | indeterminate spinner |
| VisionAnalysis | "Fotos werden analysiert (Azure Vision)" | indeterminate spinner |
| Done | success checkmark | auto-redirect to Recipe-Form after 500ms |
| Error | red banner | error message + retry button |

### Stale-progress banner

If `LastProgressAt` was > 2 min ago AND status is still "Running", show
amber banner: *"Import reagiert nicht — neu versuchen?"* + Retry-Button.
Retry calls `POST /api/imports/{id}/retry` (new endpoint, basic — 202 on
enqueue, 409 if Done).

### Hook changes

- `useImportStatus` polls 3s (was 2s — SignalR is primary now).
- Polling auto-stops if last SignalR event received < 2s ago (heuristic).
- Poll remains authoritative fallback for SignalR disconnect / tab-hidden.

### Shared types

`packages/shared/src/types/recipeImport.ts`:
```ts
export type RecipeImportPhase = 'queued' | 'downloading' | 'transcribing'
  | 'structuring' | 'post_processing' | 'vision_analysis' | 'done' | 'error';

export interface RecipeImportDto {
  // existing fields...
  phase: RecipeImportPhase;
  phaseProgress: number;
  bytesDownloaded?: number;
  bytesTotal?: number;
  segmentsDone?: number;
  segmentsTotal?: number;
  attemptNumber: number;
}
```

## Error Handling

- **Python callback fails (5xx/timeout/unreachable):** ProgressReporter
  logs warning, continues. Extraction survives.
- **Bad HMAC on .NET:** 401 response, Python logs ERROR, continues.
- **Out-of-order callbacks:** rejected by domain out-of-order guard.
- **Concurrent retry race (old attempt's callback arrives after new
  attempt started):** rejected by attempt-number guard.
- **Worker crash mid-phase:** `LastProgressAt` staleness → 2-min UI banner
  offers manual retry.

## Security

- Per-import HMAC token scoped to one importId, 10-min expiry.
- `/api/internal/*` not Caddy-routed externally.
- Rate-limit 500 POST/min per importId → 429 on flood.
- Tokens carry `expiresAt` — no replay after expiry.

## Testing

### Backend (.NET)
- Domain: weighted formula correctness, out-of-order/retry guards, invalid
  transitions, auto-derived German labels.
- Endpoint: 204/401/404/422/429, cross-import-tampering rejection, idempotent
  no-extra-publish when state unchanged, publishes to correct group.
- Integration: retry #2 resets progress + bumps AttemptNumber; error path
  sets Phase=Error + German label.

### Python
- ProgressReporter throttle, phase-transition flush, fire-and-forget
  error tolerance, null callback_url no-op.
- Pipeline tests pass `NullProgressReporter()` → reproduces today's behavior.
- New progress-integration tests via stub downloader/transcriber calling
  `on_progress`/`on_segment`.

### Frontend
- `ImportProgressPage` renders PhaseStepper with correct active phase.
- Downloading shows bytes formatted German.
- Transcribing shows segments + ETA when segments_done > 2.
- RetryIndicator hidden/shown by attemptNumber.
- SignalR event applies via setQueryData (no refetch).
- Disconnected SignalR → polling still fires every 3s.
- Pure helpers: `computeGlobalProgress`, `formatBytes`, `formatEta`.

### E2E smoke
`scripts/smoke-live.sh --import-url=<url>` mode: runs import, polls,
asserts ≥3 distinct phase snapshots observed during the run.

## Sub-Slice Decomposition

All under the 4-stage flow (impl → /simplify → /security-review → reviewer).

### PV1 — Backend Domain + Endpoint + Caddy hardening (~2-3h)
- `RecipeImportPhase` enum + schema fields (incl. stored `ProgressLabel`) + migration
- `UpdateProgress` domain method with weighted formula + out-of-order + retry guards
- `POST /api/internal/imports/{id}/progress` + per-import HMAC middleware
- SignalR event + `LiveSyncPublisher.RecipeImportProgressChangedAsync` + payload type
- **Caddy defense layer 1**: both `Caddyfile` + `Caddyfile.prod` get
  `@internal path /api/internal/*` → `respond 404` before reverse_proxy
- **App defense layer 2**: middleware on `/api/internal/*` rejects non-internal
  origins (docker bridge CIDR allowlist) — integration test confirms external
  origin gets 404/403
- ≥20 .NET tests (including two-layer defense tests)

### PV2 — Python ProgressReporter + Pipeline Integration (~2-3h)
- `ProgressReporter` class + throttle + HMAC POST
- `YtDlpDownloader.on_progress` + `FasterWhisperTranscriber.on_segment`
- Pipeline threading (url + photo paths)
- ≥15 Python tests

### PV3 — Frontend: PhaseStepper + DetailCard + useLiveSync wiring (~2h)
- Component split + shared types + German formatters
- `useLiveSync` extended for `RecipeImportProgressChanged`
- `useImportStatus` 3s poll + staleness banner
- ≥15 web tests

### PV4 — E2E Smoke + Docs + Deploy (~1h)
- `scripts/smoke-live.sh --import-url=<url>` assert ≥3 phases
- `docs/ops.md` section on `/api/internal/*` + troubleshooting
- Tag `v0.4.0` → deploy → live verification

**Total est:** 7-9h agent-time, 1-2 days wall-time.

## Success Criteria

- E2E FB-Video-Import shows ≥3 distinct progress snapshots during run
  (not just 0→10→100).
- Latency Python-callback → Frontend UI update <500ms via SignalR.
- Polling fallback shows updates within 3s on SignalR disconnect.
- All existing tests stay green (no regression on current 2271-test baseline).
- Prod smoke-live.sh passes.

## Non-Goals

- Live-transcript-preview (first few words appearing during transcription —
  possible but adds complexity not worth it; deferred).
- Photo-import within-phase progress (Azure Vision is single-shot, no
  meaningful sub-phase).
- Chat flow progress (synchronous <5s, spinner is sufficient).
- Websocket-based callback from Python (HTTP POST is simpler, P3-8 already
  does WebSocket for UI).
- Hangfire dead-letter/reaper (separate slice PF5 if needed).
