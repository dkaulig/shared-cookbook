# P2-8 — Web UI: Photo Import Flow

**Slice:** P2-8
**Status:** planned
**Date:** 2026-04-18
**Depends on:** P2-6 (bridge endpoints) + P2-7 (progress UI infra shared).
**Parent plan:** `docs/plans/2026-04-18-phase-2-architecture.md`.

## Why

Second user-facing AI path. User's wife has paper recipe collection. Photos → structured recipe → Review → save. Mirrors P2-7 flow with a different upload surface.

## Scope

### 1. Entry points

- "+ Rezept aus Foto importieren" button — added to `HomePage.tsx` and `GroupDetailPage.tsx` next to the P2-7 URL-import entry.
- Opens route `/rezepte/import/photos`.

### 2. `/rezepte/import/photos` route

Upload surface:
- Multi-photo upload (drag-drop + file picker + mobile camera capture via `<input type="file" accept="image/*" capture="environment">`).
- Thumbnails rendered from `URL.createObjectURL` (same pattern as UX1-PU's `PhotoUploadGrid` staged mode).
- 1..10 photos.
- Reorder via simple ↑/↓ buttons (no drag-reorder in v1 for mobile ergonomics).
- Group picker if user has > 1 group.
- Submit "Rezepte extrahieren".

On submit:
1. Sequentially upload each `File` to `POST /api/recipes/photos/staged` (new endpoint? or reuse a temp-upload path — decide). The photos need to live somewhere the Python service can read.
2. Once all photos have their signed URLs → `POST /api/recipes/import/photos` → receive `importId` → navigate to `/rezepte/import/:importId`.

**Complication:** the .NET API's existing photo-upload path requires a `recipeId`. P2-8 needs a "staged" variant that stores photos under a temp id (or uses the user's id as the "owner" without a recipe binding). This is new .NET work that belongs either in P2-6 or P2-8 — scoping this to **P2-8** since it's photo-specific.

### 3. .NET addition: `POST /api/recipes/photos/staged`

Uploads a photo to SeaweedFS keyed by `{userId}/staged/{photoId}`, returns a signed URL. TTL: 1 hour (photos must be consumed by a subsequent `/import/photos` call within the hour).

Tests:
- Upload → returns signed URL.
- Second upload → new photoId.
- Signed URL is time-limited.
- Anonymous → 401.

### 4. Progress screen

**Reuses `/rezepte/import/:importId` from P2-7.** No new route, same component handles both video and photo imports — reads `RecipeImport.Source` and labels accordingly:
- `Source === 'Url'`: "Video wird geladen …" etc.
- `Source === 'Photos'`: "Fotos analysieren …" / "Rezept erkennen …" / "Rezept strukturieren …"

### 5. Prefill + save

**Reuses `RecipeFormPage`'s `?importId=` prefill from P2-7.** Same banner, same missing-quantity highlights. Additionally:
- If the recipe contains any ingredient/step with `confidence="handwritten_uncertain"`, those get an orange "Handschrift prüfen"-badge.
- The staged photos get attached to the newly-created recipe on save (via the existing `/api/recipes/{id}/photos` upload flow — but the photos are already on SeaweedFS under `staged/`, so we can `POST /api/recipes/{id}/photos/promote` with the stagedPhotoIds to move them without re-upload).

### 6. Tests

Web:
- `ImportPhotosPage.test.tsx`: uploads 2 photos, submits, navigates to progress.
- `RecipeFormPage.test.tsx` additions: `confidence="handwritten_uncertain"` badges render.

.NET:
- `POST /api/recipes/photos/staged` integration tests.
- `POST /api/recipes/{id}/photos/promote` integration tests.

## Non-goals

- No background cleanup of abandoned staged photos (rely on SeaweedFS TTL + periodic sweep job in Phase 3).
- No HEIC support (iOS default format) for v1 — reject with "Bitte als JPG/PNG speichern".
- No client-side image compression.

## Acceptance criteria

- Web gates green.
- .NET gates green with new `staged` + `promote` endpoints.
- Manual smoke: upload 2 paper recipe photos → progress → prefilled form → save → recipe exists with both photos attached.

## Anti-shortcut reminders

- TDD.
- Staged photo TTL enforced server-side, not just signed URL expiry.
- Promote endpoint must verify the caller owns the staged photos (userId match).
- Don't copy SeaweedFS data on promote — just rewrite the metadata/index.
