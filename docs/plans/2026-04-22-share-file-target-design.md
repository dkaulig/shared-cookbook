# Web Share Target — file sharing (photos)

**Date:** 2026-04-22
**Slice ID:** SHARE-1
**Depends on:** SHARE-0 (GET-based URL sharing) shipped in
`99aa831`.
**Status:** 📋 Designed, ready to dispatch.

## Why

Today's photo-import flow from a gallery:

1. Open Photos app, pick the recipe screenshot.
2. Share → Copy image (or Save to Files).
3. Switch to Familien-Kochbuch PWA.
4. `+` → "Rezept aus Foto importieren".
5. Tap upload → navigate to file → pick.
6. Wait for AI extraction.

With a POST/multipart share target the same flow becomes:

1. Photos app → Share → tap "Familien-Kochbuch".
2. PWA opens with the image already staged, import fires.

SHARE-0 handled the GET-based URL case. SHARE-1 adds the
POST-multipart case for binary files — specifically images for the
photo-import path.

## Platform support

- **Android Chrome / Samsung Internet / Edge Android**: POST +
  `multipart/form-data` share-target supported since Chrome 71. Well-
  established, no special handling.
- **iOS Safari 17.4+**: supports POST share-target for PWAs. Still
  newer than Android but works. Same "delete + re-install PWA" dance
  as SHARE-0 when the manifest changes.
- **Max file size**: no hard spec; in practice iOS caps at ~30 MB per
  share. Our backend already caps staged-photo upload at 10 MB per
  file — we reject oversized shares with a German error before
  kicking off the import.

## Manifest

Extends SHARE-0's `share_target` entry with a `files` param + POST
method. **New combined entry replaces the SHARE-0 GET entry** — a
single `share_target` registration can handle either.

```json
"share_target": {
  "action": "/share-target",
  "method": "POST",
  "enctype": "multipart/form-data",
  "params": {
    "title": "title",
    "text":  "text",
    "url":   "url",
    "files": [
      {
        "name": "files",
        "accept": ["image/jpeg", "image/png", "image/heic", "image/webp"]
      }
    ]
  }
}
```

**Compatibility note:** SHARE-0's GET-based URL handling stops
working the moment we switch `method` to POST — browsers won't auto-
URL-encode a POST-target as GET. The `/share-target` route server +
component must handle BOTH cases:

- POST with form-data (Android + iOS 17.4+ file shares, but also URL-
  only shares on some platforms)
- GET with query params (older browsers + URL-only shares where the
  browser doesn't bother with multipart)

The route component checks `request.method` (server-side) /
`navigation.location.search` vs body (client-side) and branches.

## Route changes

`/share-target` becomes a **service-worker-intercepted POST handler
+ GET fallback**. The SW pattern:

1. Service worker registers a `fetch` handler that catches
   `POST /share-target` requests.
2. Handler reads the multipart body via `request.formData()`,
   extracts `files[]` + `url`/`text`/`title`.
3. Stashes the file-blobs into **IndexedDB** (not sessionStorage —
   blobs don't serialize). Uses a rotating key `share-target-
   payload-<timestamp>`, cleaned up on read.
4. Responds with a redirect to `/share-target` (GET) — but the
   client-side route component knows to read from IndexedDB when the
   URL has `?payload-key=<timestamp>`.

Client-side component (`ShareTargetPage.tsx`) augments:

1. Authenticated + `?payload-key=...` → read blobs from IndexedDB,
   `navigate('/rezepte/import/photos', { state: { stagedBlobs:
   File[] } })`. ImportPhotosPage picks them up from router state
   and pre-fills the staging grid.
2. Authenticated + `?url=...` → SHARE-0 behaviour (redirect to
   import-url).
3. Authenticated + payload-key MISSING **and** URL MISSING → error
   page (same as SHARE-0).
4. Unauthenticated → `/login?next=...` (same as SHARE-0).

## ImportPhotosPage pre-fill

`ImportPhotosPage.tsx` today expects the user to tap the upload
affordance + select files. New prop / router-state hook: on mount,
if `location.state.stagedBlobs` is non-empty, immediately stage
those blobs via the existing `usePhotoStaging` hook as if the user
had picked them. No auto-kick-off of the Azure import — user sees
the staged photos + can still add more + tap "Importieren"
explicitly. Prevents accidental costly extractions on phantom
shares.

## Service worker

Currently vite-plugin-pwa generates a SW via workbox. We need a
**custom SW handler** for `POST /share-target`. vite-plugin-pwa
accepts a custom SW source (`strategies: 'injectManifest'` mode) or
a `navigateFallbackDenylist`. Either approach works; pick the
cleaner one during impl.

## TDD

- `extractSharedFiles.ts` helper (symmetric to SHARE-0's
  `extractSharedUrl.ts`): takes `FormData`, returns `File[]` after
  filtering by MIME type + size. Theory tests per case: JPEG
  accepted, PNG accepted, HEIC accepted, WebP accepted, oversized
  rejected, non-image MIME rejected, empty file list → `[]`.
- `ShareTargetPage.test.tsx` extended: the new `?payload-key=...`
  branch → assert `navigate('/rezepte/import/photos', { state:
  ... })` fired with the right blob list.
- Service-worker handler test: mock `FormData`, assert IndexedDB
  write + redirect response with the correct `payload-key` param.
- IndexedDB cleanup test: stale payloads older than 5 min get
  purged on each share-target hit. Unit-test the purge helper.

## Verification

- Local jsdom tests are the gate.
- Real-device verification (after deploy): user shares a photo from
  iPhone Photos → Familien-Kochbuch appears in share sheet → tap →
  PWA opens with photo staged → user hits "Importieren" → import
  fires. Same flow on Android.

## 4-stage flow

- /simplify: SW handler + IndexedDB helper + route branch = ~120
  LOC. Don't invent a `ShareTargetStateProvider` context; the
  payload is consumed once on mount.
- /security: the uploaded file-blob is attacker-controlled (anyone
  who can invoke the share sheet). MIME-type filter + 10 MB/file
  cap + 5-item max rejected at extraction. The backend's existing
  staged-photo-upload validation is the second layer. No file is
  read as text or rendered as HTML — they go straight into the
  upload pipeline.
- fix-commit: `feat(web): SHARE-1 iOS/Android PWA file-share target for photo imports`.
- reviewer: final verdict + file:line citations.

## Release-note bullet

> **Foto aus Galerie direkt freigeben** — Bilder aus der iPhone-/
> Android-Fotos-App können jetzt über das native Teilen-Menü direkt
> in Familien-Kochbuch gesandt werden. Im Share-Sheet "Familien-
> Kochbuch" auswählen; die App öffnet sich mit dem Foto schon
> vorbereitet, ein Tap auf "Importieren" startet die AI-Extraktion.
> iOS: nach diesem Update einmal die PWA neu installieren damit das
> erweiterte Manifest eingelesen wird.

## Out of scope (not for SHARE-1)

- Sharing a video file (not a photo): videos via share-target are
  cross-platform buggy + our video-import is URL-based anyway. Stay
  URL-only for video.
- Non-image files (PDF with a printed recipe, a screenshot of a
  paper cookbook): cover later with a generic "share any image →
  photo-import" rule; PDFs need OCR which is a separate slice.
- Multi-file sharing where some pass MIME-filter + some don't:
  silently drop the rejected ones + surface a German toast after
  ImportPhotosPage mounts ("2 von 3 Bildern übernommen, 1 war kein
  unterstütztes Format").

## Known dependency gap

**SHARE-0b `/login ?next=` support** is still open — if
SHARE-1 lands first and a user shares a photo while logged out, the
payload reaches `/login?next=/share-target?...` but post-login they
end on `/`. Same gap as SHARE-0. Either bundle SHARE-0b with SHARE-
1 or accept the UX hit temporarily.

Recommendation: ship SHARE-0b alongside SHARE-1 since the fix is
~15 LOC and the bug is more noticeable once file-share is live.
