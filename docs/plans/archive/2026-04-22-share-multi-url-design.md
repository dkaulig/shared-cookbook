# Web Share Target — multi-URL payloads

**Date:** 2026-04-22
**Slice ID:** SHARE-2
**Depends on:** SHARE-0 (single-URL GET) shipped in `99aa831`.
**Status:** 📋 Designed, ready to dispatch.

## Why

Some share scenarios deliver more than one URL at once:

- Safari's "Share All Pages" on iPad splits multiple tabs into one
  share with N URLs.
- Messaging apps (WhatsApp, Telegram) sometimes forward a message
  containing several links, which the native share sheet serializes
  as multi-line text.
- Instagram's "Share multiple" for Saved Reels bundles 2-3 reel URLs
  into the payload.

SHARE-0's extractor takes the **first** usable URL and ignores the
rest. That's fine for the 90 % case (one reel, one blog) but drops
value in the multi-share case. SHARE-2 teaches the extractor to
surface ALL URLs and hand the user a picker when >1 is found.

## UX model

Three behaviours based on the payload:

1. **Exactly 1 URL detected** → silent redirect to `/rezepte/import/
   url?url=<extracted>` (SHARE-0 behaviour, unchanged).
2. **2–10 URLs detected** → `/share-target` renders a **picker page**
   listing each URL as a card with an optional thumbnail-preview
   (fetched asynchronously, OpenGraph-only, no JSON-LD follow). User
   picks one → redirect to the import-url flow. Option "Mehrere
   importieren": start N sequential imports, land the user on the
   import-list page where they can watch progress.
3. **>10 URLs detected** → reject with a German error "Maximal 10
   Links auf einmal — bitte auswählen". Sanity cap.
4. **0 URLs + empty-share** → unchanged, error page.

## URL extraction upgrade

Current `extractSharedUrl` returns `string | null`. SHARE-2 adds a
sibling `extractSharedUrls` that returns `string[]` (empty, 1, or
many). Strategy:

- Collect candidates from all three params (`url`, `text`, `title`).
- Regex-extract ALL `https?://[^\s<>"')\]]+` hits per value.
- Deduplicate by string equality (no fancy URL-canonicalisation;
  `http://foo.com/` and `http://foo.com/#` are treated as distinct —
  the user can dedupe in the picker).
- Apply SHARE-0's per-URL sanitise rules (http(s) only, ≤ 2000
  chars).
- Cap the list at 10 items.

SHARE-0's `extractSharedUrl` becomes a thin wrapper:
`extractSharedUrls(params)[0] ?? null`.

## Picker UI

New page `apps/web/src/features/share/ShareMultiPickerPage.tsx` (or
inline branch inside ShareTargetPage — whichever the impl agent
thinks cleaner). Renders:

- German headline: "Welches Rezept willst du importieren?"
- List of URL cards:
  - Primary: the URL (truncated to the host + first path segment)
  - Optional: favicon + OG-image thumbnail (lazy-loaded, fall back
    to a generic Link icon)
  - Tap card → redirect to `/rezepte/import/url?url=<that one>`
- Footer CTA: "Alle importieren (N)" button → triggers N sequential
  imports via the existing enqueue endpoint, navigates to
  `/rezepte/import` (import-list page).
- Dismiss: "Abbrechen" button → `navigate(-1)` or `/`.

## Batch-import wiring

The "Alle importieren" flow hits the existing `POST /api/recipes/
import/url` endpoint N times. The backend already handles
concurrent imports per user (Hangfire queue). No new endpoint
needed.

Frontend fires them as independent mutations, shows a toast
"3 Imports gestartet" + navigates to `/rezepte/import` where the
user can watch each one's progress.

## TDD

- `extractSharedUrls.test.ts` — helper theory cases:
  - Single URL in `url` → `[url]`.
  - Two URLs in `text` (newline-separated) → `[url1, url2]` dedup.
  - Same URL in `url` + `text` → `[url]` deduped.
  - 15 URLs in text → truncated to 10.
  - Mix of http(s) + `javascript:` → only http(s) kept.
  - Empty all → `[]`.
- `ShareTargetPage.test.tsx` new branches:
  - `?text=url1%0Aurl2` → renders multi-picker with 2 cards.
  - Multi-picker "alle importieren" fires N mutations + navigates.
  - Multi-picker "single card" taps → redirects to import-url.
  - 11 URLs → reject with German error.
- Visual: screenshot golden for the multi-picker layout.

## OpenGraph thumbnail fetch

The picker benefits from thumbnails (hard to tell `fb.com/share/r/
abc123` apart from `fb.com/share/r/xyz789` at a glance). Option A:
client-side CORS-allowed `og:image` fetch (many sites block). Option
B: backend proxy `/api/share-target/preview?url=...` that returns
`{ image, title, host }`. Option C: skip thumbnails for v1; just
host + truncated path.

Recommendation: **Option C for v1**. Adding a backend preview
endpoint is a larger slice (caching, rate-limiting, SSRF guard —
all work we could do but YAGNI at picker-stage). Revisit as SHARE-3
if users request prettier pickers.

## 4-stage flow

- /simplify: one helper rewrite, one branch in ShareTargetPage, one
  new page component, zero backend changes. ~200 LOC.
- /security: the multi-URL list is attacker-controlled; same sanitise
  rules as SHARE-0 apply per URL. No server-side changes, just more
  queued imports — backend SSRF + scheme guards are the existing
  second layer.
- fix-commit: `feat(web): SHARE-2 multi-URL picker for shared payloads`.
- reviewer: final verdict + file:line citations.

## Release-note bullet

> **Mehrere Links gleichzeitig teilen** — teile z.B. zwei Rezept-
> Reels aus Instagram, und Familien-Kochbuch zeigt dir eine Auswahl.
> Einen auswählen oder "Alle importieren" — die AI-Extraktion läuft
> für jedes im Hintergrund, den Fortschritt siehst du unter "Meine
> Imports". Maximal 10 Links pro Share.

## Out of scope

- URL canonicalisation (treating `foo.com/` and `foo.com/#` as same).
  Simple string-dedupe suffices.
- Thumbnail preview via backend proxy (SHARE-3 candidate).
- Batching the N imports into a single backend call (the existing
  per-URL endpoint handles it; no batching needed).
- Deduping against recipes the user has ALREADY imported before
  (would require a SourceUrl-history lookup at share-target time;
  worth it only if users start sharing duplicates frequently).

## Tag-sync note

Per user directive "kein Tag zwischendurch, wir bündeln SHARE-0/1/2":
SHARE-2 lands on `main` without a tag. After SHARE-0 + SHARE-1 +
SHARE-2 are all merged, orchestrator cuts one combined `v0.x` tag
that ships the whole Web-Share-Target family.
