# Web Share Target — iOS PWA share-sheet integration

**Date:** 2026-04-22
**Slice ID:** SHARE-0
**Status:** 📋 Designed, ready to dispatch.

## Why

Today's flow to import a Facebook / Instagram / TikTok reel into the
family cookbook on iPhone PWA:

1. Open the reel in Safari / native app.
2. Tap Share → Copy link.
3. Switch app to Familien-Kochbuch PWA.
4. Tap `+` → "Rezept aus Video importieren".
5. Tap address field → Paste.
6. Tap "Importieren".

Six taps, three app-switches, one copy-paste. Error-prone + clunky.

With a PWA share-target the same flow becomes:

1. Open the reel.
2. Tap Share → tap "Familien-Kochbuch".
3. PWA auto-opens, URL pre-filled, import fires.

Three taps, zero copy-paste.

## What makes this work on iOS

- **iOS 17.4+** supports the W3C Web Share Target API for PWAs added
  to Home Screen (user is on iOS 18 per the iPhone 17 Pro Max).
- The PWA must have been **installed via "Zum Home-Bildschirm"** at
  least once since the manifest started advertising
  `share_target`. A plain Safari-tab install does not register the
  target in the share sheet.
- **After the manifest change ships, the user must re-install the
  PWA** (delete from home screen, re-add from Safari menu) for iOS
  to re-read the manifest. Documented in the release note + SETUP.md.
- Facebook's iOS share sheet typically drops the reel URL into the
  **`text`** query param (not `url`). Instagram sometimes uses
  `url`. Our route must read both, `url` preferred.

## Scope

### Manifest change

`apps/web/vite.config.ts` → existing `VitePWA({ manifest: ... })`:

```json
"share_target": {
  "action": "/share-target",
  "method": "GET",
  "params": {
    "title": "title",
    "text":  "text",
    "url":   "url"
  }
}
```

Only `GET` — simpler than POST (no multipart file handling), good
enough for URL sharing. File-upload sharing (share a photo → trigger
photo-import) is a separate follow-up slice.

### Route

New top-level route `/share-target` in `App.tsx` under the protected
`<AppLayout>`. Renders a thin component:

1. **Not authenticated:** `<Navigate to="/login?next=/share-target?…" replace />` so the user logs in and lands back on the share-target with the original query intact.
2. **Authenticated + URL payload present:** immediately `navigate('/rezepte/import/url?url=<extracted>', { replace: true })` so the existing import-url flow takes over. The `replace` matters — user shouldn't hit "Back" and land on a barren `/share-target` URL.
3. **Authenticated + no usable payload:** render a short German error page: "Kein Link in der Freigabe gefunden. Bitte manuell importieren." + link to `/rezepte/import/url`.

### URL extraction logic

```ts
function extractSharedUrl(search: URLSearchParams): string | null {
  // Priority order (FB drops URL into text, IG uses url, sometimes
  // they land in title). First non-empty hit wins.
  for (const key of ['url', 'text', 'title'] as const) {
    const raw = (search.get(key) ?? '').trim()
    if (!raw) continue
    try {
      const u = new URL(raw)
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString()
    } catch {
      // Not a parseable URL — some share sheets drop multi-line text
      // with the URL embedded. Fall back to a regex extraction.
      const match = raw.match(/https?:\/\/[^\s<>"')\]]+/)
      if (match) return match[0]
    }
  }
  return null
}
```

`http://` + `https://` only — no `javascript:` / `file://` / `data:`.
The backend's existing SSRF guards + the `Recipe.ValidateSourceUrl`
scheme check (BUG-047) provide defence-in-depth once the URL gets
to the import pipeline.

### Auto-install safe-area-top offset

Installed-PWA-on-iPhone-17 Pro Max has a notch — the `/share-target`
transitional page will flash for a frame. Render it inside the
normal `AppLayout` so the notch-clear pt-safe inset stays correct; a
lonely "Rezept wird geöffnet…"-spinner + home-icon + `aria-busy`.
Simple; no UI flourishes because it renders for < 150 ms.

### Sessions list shortcut

Nice-to-have: if the user has been sharing multiple reels in quick
succession, the share-target page can read a `?ref=share-target`
flag and log it to dev-console. Not user-visible. Skip unless the
agent finds it useful for debugging.

## TDD

- `ShareTarget.test.tsx` or extend `App.test.tsx` route tests:
  - URL in `?url=...` → redirects to `/rezepte/import/url?url=...`.
  - URL in `?text=...` with raw URL → same redirect.
  - URL embedded in a multi-line `?text=...` → regex extracts + redirect.
  - `?title=https://...` fallback → redirect.
  - No usable payload → empty-state renders, no redirect.
  - `javascript:alert(1)` in `?url=...` → refused, empty-state renders.
  - Unauthenticated → redirect to `/login?next=/share-target?...` with query preserved.
- Type-safe URL extraction helper has its own focused unit tests
  covering the priority order + regex fallback.

## Verification

Local jsdom tests are the gate. Real iOS device share-sheet can't be
automated — the release note documents the one-time "re-install the
PWA" step so the user can verify on their iPhone after deploy.

## 4-stage flow

- /simplify: one route, one helper, one manifest entry. No `ShareTargetProvider` context, no state machine. ~80 LOC total.
- /security: the `url` payload is attacker-controlled (anyone can craft a share payload). Regex + URL-parser gate at the route catches `javascript:`/`data:`/`file:` before the Import pipeline touches it. The Import pipeline's existing SSRF + scheme validation is the second layer.
- fix-commit: `feat(web): SHARE-0 iOS PWA share-target for URL imports`.
- reviewer: final verdict + file:line citations.

## Release-note bullet

> **iPhone PWA kann jetzt Shares aus Facebook / Instagram / TikTok
> direkt entgegennehmen.** Nach diesem Update einmal die PWA vom
> Home-Screen löschen und per "Zum Home-Bildschirm" neu anlegen,
> damit iOS das neue Manifest einliest. Danach erscheint
> "Familien-Kochbuch" im Share-Sheet.

## Open questions

- **Android Chrome** handling (not our primary target, but): Chrome
  share-target also works — the same manifest entry covers both
  platforms. No Android-specific code needed for v1.
- **File-sharing** (share a photo → trigger photo-import): separate
  future slice. Requires `method: "POST"` with `enctype:
  "multipart/form-data"` + file-handler on the backend.
- **Multi-URL share** (shares two URLs in one payload): out of
  scope. Take the first usable URL.
- **Domain-sniffing** (only accept FB/IG/TikTok URLs): deliberately
  NOT doing this — the import pipeline accepts any http(s) URL
  that returns sensible content. Adding a domain allowlist here
  would break blog imports that we explicitly want to support.

## Follow-up slices

- **SHARE-0b — `/login ?next=` support.** Unauthenticated share
  payloads preserve the original URL via `?next=`, but `LoginPage`
  hardcodes post-login redirect to `/`. ~15 LOC fix (read `next`
  query param after successful login, navigate there with a safety
  allowlist — same-origin paths only). Recommend bundling with
  SHARE-1 since file-sharing makes the unauth-share UX loss more
  visible.
- **SHARE-1 — file sharing (photos).** POST multipart. Detail plan:
  `docs/plans/2026-04-22-share-file-target-design.md`.
- **SHARE-2 — multi-URL picker.** User shares 2-3 reels at once,
  picker UI lets them choose or start N imports. Detail plan:
  `docs/plans/2026-04-22-share-multi-url-design.md`.

## Relationship to the OSS release plan

Not a release-gate — SHARE-0 can land before or after the public
release. If it ships before, it's a nice headline feature. If it
slips, the copy-paste flow still works. Adding to the release-plan
doc as an optional polish-slice.
