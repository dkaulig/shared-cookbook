# Import cover-picker — choose from N candidate thumbnails

**Date:** 2026-04-22
**Slice ID:** COVER-0
**Status:** 📋 Designed, ready to dispatch.

## Why

Today's URL-import flow auto-picks exactly one thumbnail:

- Video (FB / IG / TikTok / YouTube): yt-dlp returns one thumbnail URL,
  often a random frame that's a half-blink / mid-speech / logo-card
  moment. The user sees the cover on the recipe form + either
  accepts it or manually uploads a replacement.
- Blog: `og:image` or the first JSON-LD `image` entry wins.

User feedback (2026-04-22): *"manchmal werden in videos echt merkwürdige
screenshots genommen"*. The one-shot auto-pick fails often enough on
reels that the user wants to see 4–6 options and choose — the
"interesting moments" of a 15 s reel are usually the ingredients
layout, a cooking step, and the final dish, not the opening logo
frame.

## UX goal

User imports a video URL → form opens with a **3×2 grid of 6
candidate thumbnails**, the first marked as cover (star badge). User
can:

1. Do nothing → save → the default cover stands.
2. Tap a different thumbnail → that becomes the cover, the old cover
   drops to "additional photo".
3. Long-press / star-tap a thumbnail → promotes that one to cover.
4. Multi-select 1–3 → first selected = cover, rest get saved as
   additional photos; unselected thumbnails are dropped.

For 7 days after the recipe is saved, unused candidates stay
available via a **"Cover ändern"** button on the recipe detail page.
After 7 days the hourly sweep reaps them.

## Scope (what's in, what's not)

**In:**

- Video imports (yt-dlp + ffmpeg-extracted frames).
- URL/blog imports where JSON-LD `image[]` has ≥ 2 entries (zero
  extra scraping; the Python pipeline already parses this).
- Generalising BUG-018's existing one-thumbnail pipeline to N
  thumbnails.

**Out (deferred):**

- HTML article-body `<img>` scraping for blogs without structured
  data (SHARE-3 territory — larger Python-extractor change + SSRF
  cost).
- Photo-import flow (`/rezepte/import/photos`) — user is already
  explicitly picking images there; no candidates to mine.
- Chat-import flow — no source media.
- Thumbnail-preview fetching on the share-target multi-URL picker
  (separate future slice; that picker is about URLs, not candidates).

## Source pipeline

### Video imports (Python extractor)

`apps/python-extractor/src/extractor/pipeline/` — extend the existing
URL-extraction pipeline:

1. **yt-dlp thumbnails** — yt-dlp's `info_dict['thumbnails']` returns
   2–5 variants per video (different resolutions + moments on
   FB/IG/TikTok). Keep the top 2 by resolution.
2. **ffmpeg frames** — extract 4 frames at 15% / 35% / 60% / 85% of
   the video duration (ffmpeg `-ss $time -vframes 1`). Emit as JPEG
   at 1280×720 max (maintain aspect).
3. Dedup: if a yt-dlp thumbnail and an extracted frame land within
   500ms of each other, prefer yt-dlp (already on CDN, no encode
   cost).
4. Cap at 6 candidates. The ordering in the returned list defines
   the default Cover (index 0 = default Cover).

**Perf:** the 4 ffmpeg frame extractions add ~1–3 seconds to a
typical 30-second reel import. Acceptable — the Whisper transcription
is the long-pole (10–30 s). Frames are extracted *after* the video
download completes, in parallel with Whisper (yt-dlp file is already
on disk).

### URL/blog imports (Python extractor)

Use the JSON-LD `image` field. Schema.org Recipe allows:

- `image: "https://…"` — single URL.
- `image: ["url1", "url2", …]` — array.
- `image: { url: "https://…", width: …, height: … }` — object (or
  array of objects).

Flatten to a string array, cap at 6. If the array has ≥ 2 entries
→ emit as candidates. If ≤ 1 → behave exactly as today (single
thumbnail_url, no picker).

### Shared output shape

The Python `ExtractedRecipe` TypedDict gains:

```python
candidate_thumbnails: list[str]  # 0-6 absolute URLs, ordered, [0] = default Cover
```

The existing `thumbnail_url: str | None` stays for backward compat
for one migration cycle, then gets removed (no deprecation shim per
CLAUDE.md — delete the field, update the prefill code, one commit).

## Backend data model

### StagedPhoto extension

`apps/api/src/FamilienKochbuch.Domain/Entities/StagedPhoto.cs` gains
one field:

```csharp
/// <summary>COVER-0 — the import this staged photo was created
/// as a candidate for. Non-null for thumbnails captured by the
/// candidate-download pipeline; null for user-uploaded staged
/// photos (the photo-import flow).
///
/// Also signals the extended 7-day TTL: the sweep job skips rows
/// where LinkedImportId is non-null until 7 days post-creation
/// (vs 24 h for manually-uploaded staged photos).</summary>
public Guid? LinkedImportId { get; private set; }
```

`CandidateOrder: int?` — 0-indexed position within the 6-candidate
set, null for non-candidate rows. The frontend uses this to render
tiles in the deterministic order the extractor produced.

Migration: `AddImportCandidateFieldsToStagedPhoto`. Two new
nullable columns, no data migration needed.

### RecipeImport extension

No schema change needed — the existing `Result` JSON already carries
the `ExtractionResult` which will grow the `candidate_thumbnails`
array.

Add one helper column for fast lookup: `HasRetainedCandidates: bool`
set during the candidate-download job, cleared when the sweep reaps
the last candidate. Lets RecipeDetailPage query "does this recipe's
origin-import still have candidates?" without joining StagedPhoto.

Actually, simpler: skip the flag, just do the StagedPhoto lookup
on-demand when rendering the "Cover ändern"-button. Re-evaluate if
it becomes a hot path.

### CandidateAttacher service

Replaces the single-purpose `ThumbnailAttacher` (BUG-018). Downloads
all 6 candidates in parallel (bounded, `MaxDegreeOfParallelism = 3`
to avoid hammering a single CDN). Per-URL rules:

- Same SSRF host-allowlist as today (`.fbcdn.net`, `.cdninstagram.com`,
  `.ytimg.com`, etc.).
- 5 MB / 5 s timeout per download.
- Writes each successful download as a `StagedPhoto` with
  `LinkedImportId = import.Id`, `CandidateOrder = N`, SourceUrl =
  the candidate URL.
- Returns `Guid[] candidateStagedPhotoIds` (may contain gaps if some
  downloads failed; frontend renders only the successful ones).

No deprecation shim — delete `ThumbnailAttacher`, remove the
`thumbnailStagedPhotoId: Guid?` field from `RecipeImport`, replace
with `candidateStagedPhotoIds: Guid[]`.

## API contract

### `GET /api/imports/{importId}` (extended)

`RecipeImportDto` drops `thumbnailStagedPhotoId`, adds:

```ts
candidateStagedPhotoIds: string[]  // up to 6, ordered; [0] = default Cover
```

### `GET /api/imports/{importId}/candidates` (new)

Returns the still-unpromoted StagedPhotos linked to this import,
freshly signed URLs. Used by the RecipeDetailPage "Cover ändern"
flow to refetch after the import dropped out of cache.

```ts
interface ImportCandidatesResponse {
  candidates: Array<{
    stagedPhotoId: string
    signedUrl: string
    contentType: string
    candidateOrder: number
    expiresAt: string  // ISO-8601, 7 days post-createdAt
  }>
}
```

403 if the caller doesn't own the import. 410 Gone if the TTL
expired (sweep already reaped).

### `POST /api/recipes` (existing, extended)

Already accepts `stagedPhotoIds: string[]`. Add one optional field:

```ts
coverStagedPhotoId?: string  // which one of stagedPhotoIds is the cover
```

If omitted, the first entry is cover (backwards-compatible with the
existing single-thumbnail prefill).

### `POST /api/recipes/{id}/cover` (new)

For the "Cover ändern" flow post-save. Body: `{ stagedPhotoId }`.
Validates ownership + that the staged-photo is either already
promoted onto this recipe OR is an un-promoted candidate of the
origin-import. Promotes (if needed), swaps the current cover out to
additional photo, returns the updated Recipe.

## Frontend

### RecipeFormPage (existing, extended)

`apps/web/src/features/recipes/RecipeFormPage.tsx` today renders a
photo-grid populated from the import prefill. Changes:

- Photo-grid becomes a 3×2 grid of 6 tiles when candidates are
  present (or however many succeeded).
- Each tile: thumbnail + tap-overlay. First tile shows a star badge
  ("Cover") — tap another tile's star icon to re-designate.
- Multi-select: tap a tile → selected (blue border). Selected tiles
  get saved as photos on submit; unselected get dropped (their
  StagedPhoto rows stay unpromoted, sweep will reap after 7 days).
- Default state: tile 0 pre-selected as Cover, others unselected
  (most users want exactly one cover, no extras).
- Save → `POST /api/recipes` with `stagedPhotoIds: [selected IDs]` +
  `coverStagedPhotoId`.

### RecipeDetailPage (existing, extended)

`apps/web/src/features/recipes/RecipeDetailPage.tsx`:

- Below the hero image, new "Cover ändern"-Button, visible only when
  the origin-import has unpromoted candidates left AND user is the
  recipe owner. Check via lazy query
  `useQuery(['import-candidates', importId], …)` fired only on
  button mount to avoid extra fetch on the detail page.
- Tap → modal with the 6 tiles (reuse the RecipeFormPage grid
  component). Pick → `POST /api/recipes/:id/cover` → close modal →
  invalidate recipe detail query.
- After 7 days (or when the sweep reaps), the query returns 410 and
  the button hides (show a one-time toast "Import-Kandidaten sind
  nicht mehr verfügbar" the first time).

### Shared package

`packages/shared/src/types/imports.ts`:

- Drop `thumbnail_url` (snake_case wire) + `thumbnailStagedPhotoId`
  (camelCase DTO). No migration shim.
- Add `candidate_thumbnails: string[]` (wire) +
  `candidateStagedPhotoIds: string[]` (DTO) +
  `coverStagedPhotoId?: string` (on the create-recipe request type).

## TTL + GC

`apps/api/src/FamilienKochbuch.Api/Jobs/StagedPhotoSweepJob.cs`
(existing hourly sweep):

- Today: delete StagedPhoto rows where `PromotedAt IS NULL AND
  CreatedAt < now - 24h`.
- New: also delete rows where `PromotedAt IS NULL AND LinkedImportId
  IS NOT NULL AND CreatedAt < now - 7d`. Two-branch sweep, single
  query with OR.

SeaweedFS blob deletion is already handled by the sweep — it walks
the StagedPhoto rows about to be deleted and calls
`IPhotoStorage.DeleteAsync` per row.

## Security

Threat model:

1. **SSRF via candidate URLs.** The extractor emits URLs the user
   doesn't control (they come from yt-dlp / JSON-LD), but an
   attacker who controls a target URL (e.g. a malicious blog post
   with `json-ld image: ['http://169.254.169.254/…']`) could make
   us hit internal IPs. Mitigation: same host-allowlist as today's
   `ThumbnailAttacher`. For the JSON-LD array case, if a candidate
   URL fails the allowlist, drop it silently — log + skip.
2. **Storage exhaustion.** 6 candidates × 5 MB each = 30 MB per
   import. Existing per-user rate limits (Hangfire queue + import
   cache) already cap import frequency; sweep bounds total
   accumulated size. No new limits needed.
3. **IDOR on candidate fetch.** `GET /api/imports/:id/candidates`
   must validate `import.UserId == caller.Id`. Covered by existing
   owner-check middleware + an explicit test case.
4. **Cover-swap abuse.** `POST /api/recipes/:id/cover` must validate
   that the StagedPhoto is either already promoted onto this recipe
   OR is a candidate of this recipe's origin-import. No arbitrary
   cross-recipe photo stealing.

## TDD

Python extractor:

- `test_candidate_thumbnails.py` — yt-dlp mock returns 3 variants,
  pipeline emits 6 candidates (3 yt-dlp + 3 frames); dedup test
  (close-time frames collapse); fewer-than-6 handling (short video
  → 2 yt-dlp + fewer frames).
- `test_candidate_thumbnails_jsonld.py` — JSON-LD image scalar,
  array-of-strings, array-of-objects, nested object form.

Backend:

- `CandidateAttacherTests` — parallel download, SSRF reject (host
  not in allowlist), oversized body, timeout, partial success (some
  URLs fail, some succeed → returns array with gaps handled).
- `StagedPhotoSweepJobTests` — 7-day TTL branch for
  `LinkedImportId` rows.
- `ImportCandidatesEndpointTests` — 200 with current candidates,
  403 wrong owner, 410 after sweep, candidates-expired + recipe-
  has-cover still returns 200 (the flow still works post-save).
- `RecipesCoverEndpointTests` — happy path swap, 403 non-owner, 400
  for a StagedPhoto not linked to this recipe's import.

Frontend:

- `RecipeFormPage.test.tsx` extend — 6 candidates render as grid,
  star-tap re-designates cover, multi-select toggle, default state,
  save body carries `coverStagedPhotoId`.
- `RecipeDetailPage.test.tsx` extend — "Cover ändern" button
  visible when candidates exist, hidden after 7d (410), modal flow,
  post-swap query invalidation.
- `importPrefill.test.ts` extend — new candidate array seeds
  multiple staged-photo tiles, first is default cover.

## 4-stage flow

- **/simplify** — the design reuses StagedPhoto instead of inventing
  a parallel `CandidateThumbnail` table; the sweep gets one OR-branch
  not a second job. No `ImportCandidatesProvider` context. Pick the
  cover client-side with a plain `useState`, not a state machine.
- **/security** — SSRF guard on the attacker-controllable JSON-LD
  candidate URLs is the only new attack surface. Existing
  allowlist handles it. Enumerate ownership checks on the two new
  endpoints.
- **fix-commit** — apply findings as additional commits.
- **reviewer** — verdict + `file:line` citations.

## Commits

- `feat(extractor): COVER-0 emit candidate_thumbnails in URL pipeline`
- `feat(api): COVER-0 CandidateAttacher + 7-day sweep TTL + candidate endpoint`
- `feat(web): COVER-0 multi-candidate cover picker in RecipeFormPage`
- `feat(web): COVER-0 Cover ändern button on RecipeDetailPage`
- Additional /simplify + /security fix-commits as findings surface.

Include the `Co-Authored-By: Claude Opus 4.7 (1M context)` trailer
on every commit.

No tag — COVER-0 can land before or after the public-release
bundle.

## Release-note bullet

> **Cover-Bild direkt beim Import wählen** — nach dem Import eines
> Video- oder Blog-Rezepts zeigt die Rezept-Vorschau bis zu 6
> Kandidaten (yt-dlp-Thumbnails + ffmpeg-Frames bei Videos, JSON-LD-
> Bild-Array bei Blogs). Ein Tap auf das Stern-Icon setzt das Cover;
> weitere Bilder können als Zusatz-Fotos übernommen werden. Bis zu 7
> Tage nach dem Import lässt sich die Wahl auf der Detail-Seite über
> "Cover ändern" nochmal revidieren.

## Follow-up slices

- **COVER-1 — HTML article-body image scraping.** Blogs without
  JSON-LD (rarer these days, but they exist). Top-N `<img>` tags
  by pixel area, same SSRF gates. Deferred because the JSON-LD
  coverage is already high.
- **COVER-2 — Cover-picker for the photo-import flow.** Today the
  user picks the photos they want staged; COVER-2 would let them
  also designate which is Cover. Small UX polish, same grid
  component.
- **COVER-3 — Live preview while ffmpeg extracts.** Show a
  loading-spinner grid in RecipeFormPage that swaps to tiles as
  each download resolves. Nicer UX on slow connections but
  requires streaming the candidate list (currently one-shot).

## Relationship to existing phase-progress (PV3/PV4)

The candidate-download runs *inside* the existing URL-extraction
job. It fits naturally into the `finalising` phase (after extraction
is done, before the job flips to `done`). No new phase needed; the
server-computed `progressLabel` can mention "Bildkandidaten werden
gespeichert" during that window. ImportProgressPage stays untouched.
