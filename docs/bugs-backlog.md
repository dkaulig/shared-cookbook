# Bug Backlog — User-reported

Raw bug list collected during live-testing. Not yet triaged or fixed.
Fix-session will batch these into a dedicated slice.

**Legend:** `[ ] open`, `[~] in progress`, `[x] fixed`

## Regression-test policy

**Jeder Bug-Fix bekommt einen Regressionstest**, sofern technisch
sinnvoll. Ziel: der Bug kann nicht mehr unbemerkt wiederkehren.

| Bug-Typ | Test-Strategie |
|---|---|
| Backend-Endpoint-Bug (422/500/wrong-output) | Integration-Test der genau den fehlgeschlagenen Request-Shape durchfahrt + korrektes Ergebnis assertet (z.B. BUG-011: Pydantic-Request-Validation-Test mit den genauen URL-Formaten die .NET sendet) |
| Domain-Logic-Bug | Unit-Test mit [Theory]/parametrize der alten falschen + neuen korrekten Werten |
| Frontend-UX-Bug (redirect/prefill/overlay) | Component-Test mit dem spezifischen State-Setup das den Bug triggerte (z.B. BUG-012: `ImportProgressPage` rendered mit `locationState=null` + leerem sessionStorage → assert dass redirect trotzdem feuert) |
| CSS/Layout-Bug (z-index/overflow) | Visual-snapshot oder computed-style assertion (`getComputedStyle(el).zIndex > 0`) — oder, falls flaky, Playwright-Test an v0.5+ |
| Security/Input-Validation | Test der den Attack-Input durchspielt + rejection assertet (z.B. BUG-011: pydantic rejects relative path; BUG-011-variant: attacker injection in callback_url) |
| DevOps/Infra-Bug (compose subnets, Caddy routes) | YAML-parse-Test + docker-compose-config-Test; für Caddy evtl. integration-Test mit echtem `curl` gegen lokalen Caddy |
| Rein-textuell/copy (z.B. "Phase 3" Placeholder) | Grep-Test der asserted dass der Placeholder-Text NICHT mehr im Code ist + Component-Test der den neuen Content rendert |

**Wenn ein Regressionstest technisch nicht sinnvoll ist** (z.B. "Safari
bottom-bar overlap"), das im Bug-Fix-Commit explizit dokumentieren
("Manual QA only — no automated regression possible"). Nicht einfach
weglassen.

**Priorität der Test-Layer** (je nach Bug):
1. Unit-Test (schnell, deterministisch) — bevorzugt
2. Component-Test / Integration-Test (realistischer)
3. E2E-Test (nur wenn 1+2 nicht greifen — teuer + flaky)

---

## BUG-001 · Chat-Input hidden by mobile bottom bar
**Reported:** 2026-04-19
**Status:** `[x] fixed` (2026-04-19 — `ChatPage` height-calc now uses
`100dvh` and subtracts BottomNav (88px) + `env(safe-area-inset-bottom,0px)`
in addition to the TopNav height; input footer keeps its
`pb-[calc(16px+env(safe-area-inset-bottom,0px))]` as defence-in-depth.
`viewport-fit=cover` already present in `index.html`. Regression tests
in `ChatPage.test.tsx` grep for `100dvh` + `safe-area-inset-bottom`.)
**Where:** Chat page (`/chat`) on mobile (iOS/Android PWA browser)
**Symptom:** Chat input field is cut off / hidden behind the mobile
browser's bottom bar (Safari URL bar on iOS, address bar on Chrome
Android). User has to scroll down to reach it.
**Suspected cause:** `ChatPage` uses `h-screen` or `min-h-screen`
without accounting for `env(safe-area-inset-bottom)` + `100dvh` vs
`100vh` vs browser chrome retraction on scroll.
**Likely fix area:** `apps/web/src/features/chat/ChatPage.tsx` + 
possibly a shared `MobileSafeArea` layout primitive.
**Priority:** high (blocks primary chat flow on the most common device)

---

## BUG-002 · "Gruppe bearbeiten" vs. Gruppen-Einstellungen UX split
**Reported:** 2026-04-19
**Status:** `[x] fixed` (2026-04-19 — bundled with BUG-003. Neue Route
`/groups/:groupId/settings` mit dedizierter `GroupSettingsPage` die
Name/Beschreibung/Standard-Portionen + Foto-Upload + den existierenden
`GroupMembersAndInvitesPanel` zentral managed. `GroupDetailHeader`
"Gruppe bearbeiten"-Button → `Settings`-Link auf die neue Page; alter
`EditGroupDialog` + Tests entfernt. Regression-Tests in
`GroupSettingsPage.test.tsx` (7 Tests) + aktualisierte
`GroupDetailHeader.test.tsx` Asserts auf den Settings-Link.)
**Where:** Group detail page (`/groups/:id`)
**Symptom:** "Gruppe bearbeiten" opens a dialog that feels disconnected
from group-management UX. User expects either:
(a) the edit action to live UNDER a "Einstellungen" entry point, OR
(b) "Gruppe bearbeiten" button to navigate to a dedicated settings page
   where name + photo + members + invites can all be managed together.
**Likely fix area:** `apps/web/src/features/groups/GroupDetailHeader.tsx`
+ new `GroupSettingsPage` (or consolidate `EditGroupDialog` + 
`GroupMembersAndInvitesPanel` into a single settings view).
**Priority:** medium (UX friction, not broken functionality)

---

## BUG-003 · Group photo is text-input, not image-upload
**Reported:** 2026-04-19
**Status:** `[x] fixed` (2026-04-19 — bundled mit BUG-002. Foto-Upload-
Section auf der neuen `GroupSettingsPage`: tap → File-Picker (JPG/PNG/
WebP, max 5 MB) → reused `POST /api/recipes/photos/staged` Endpoint
liefert `signedUrl` → wird via `PUT /api/groups/{id}` mit
`coverImageUrl` persistiert. Kein neuer Backend-Endpoint nötig — der
existierende staged-photo-Flow ist generisch genug. `GroupDetailHeader`
Cover-Banner zeigt jetzt `coverImageUrl` als `background-image` wenn
gesetzt, sonst die Sage-Gradient-Default. Regression-Tests:
upload-flow + persist-flow + invalid-MIME-rejection.)
**Where:** EditGroupDialog (opened via "Gruppe bearbeiten")
**Symptom:** The group-photo field accepts only a URL text input.
Users expect a proper image-upload component (click-to-select +
preview), same pattern as recipe photos.
**Likely fix area:** `apps/web/src/features/groups/EditGroupDialog.tsx`
— replace URL input with `PhotoUploadGrid`-style uploader (reuse the
recipe-photo pattern, single-slot variant). Backend endpoint may also
need a new `POST /api/groups/{id}/photo` (check — might already exist
via generic photo-upload).
**Priority:** medium (limits usability; current workaround = manual URL)
**Note:** bundles well with BUG-002 since the group-settings surface is
where both name + photo + members live together.

---

## BUG-004 · Native `window.confirm` used for destructive actions — should be modal
**Reported:** 2026-04-19
**Status:** `[x] fixed` (2026-04-19 — neue geteilte `ConfirmDialog`-
Primitive unter `apps/web/src/features/_shared/ConfirmDialog.tsx` im
shadcn-Stil (fixed-overlay, `role="dialog" aria-modal="true"`, ESC +
outside-click-dismiss, `destructive`-Default für Sicherheit,
`isLoading`-Spinner). Zusätzlich `useConfirmDialog()`-Hook für
deklarative `await confirm({ ... })`-Flows. 5 Call-Sites migriert:
TagManagementPage (Custom-Tag-Delete), RecipeDetailPage (Rezept-Delete),
GroupMembersAndInvitesPanel (Member-Remove + Invite-Revoke via Hook),
ShoppingListPage (Item-Delete), MealPlanPage (Copy-Last-Week-Override-
Guard, jetzt `default`-Variante). DeleteSlotDialog / DeleteItemDialog
blieben unverändert, da sie bereits proper-modals sind. 12 Primitive-
Tests + 8 Sweep-Site-Regression-Tests neu; 4 tests umgebaut von
`vi.spyOn(window, 'confirm')` auf Dialog-Flow. Vollständige Suite:
1030 Tests grün.)
**Where:** Group delete (confirmed) — check for pattern across all
destructive actions.
**Symptom:** Deleting a group triggers the browser's native
`window.confirm(...)` dialog (ugly, not-themed, blocking, breaks
mobile-PWA aesthetic). Should be a proper shadcn-style confirmation
modal matching `DeleteSlotDialog` + `DeleteItemDialog` patterns.
**Scope:** global. Grep for ALL `window.confirm(...)` call sites and
replace. Known suspects (to verify):
- Group delete (confirmed)
- Tag delete (likely)
- Recipe delete (likely)
- Copy-week guard path in MealPlanPage
- Logout? (check)
- Anything else grep turns up
**Likely fix:** extract a reusable `ConfirmDialog` primitive (shadcn
AlertDialog pattern) accepting `{ title, description, confirmLabel,
confirmVariant: 'destructive'|'default', onConfirm }` — replaces all
`window.confirm` call-sites with one pass.
**Priority:** medium (UX consistency + PWA polish)
**Note:** good candidate for a dedicated "UI-consolidation" slice —
pairs with the deferred `FixedOverlayDialog` extraction from P3-7.

---

## BUG-005 · Avatar "K" overlaps top-nav (back arrow + settings cog) on group detail + list
**Reported:** 2026-04-19
**Status:** `[x] fixed` (2026-04-19 — standardised the z-scale: sticky
top-navs at `z-20` (TopNav, page sub-navs on GroupDetailPage,
ShoppingListPage), in-flow page avatars at `z-10` (GroupDetailHeader
avatar wrapper), modals at `z-50`. Sub-navs were `z-[9]` which lost
the stacking fight against the avatar (`z-10`); bumping to `z-20`
(same scale as the global TopNav) keeps the back-arrow + settings-cog
tap-targets above the avatar while scrolling. Three regression tests
added — `TopNav.test`, `GroupDetailHeader.test`,
`GroupDetailPage.test` — assert the z-tokens stay put.)
**Where:**
- Group detail page (`/groups/:id`) — avatar slides over the top bar
  containing back-arrow + settings-cog
- "Die Liste" (likely recipe list view in group / or groups-list
  landing) — same overlap
**Symptom:** User-avatar (single letter "K") visually overlaps the
fixed/sticky top-navigation at the page top. Back-arrow + settings-cog
end up underneath and become hard to tap.
**Suspected cause:** z-index stacking. Either
- Avatar has higher z-index than the top-nav, OR
- Top-nav is not `sticky top-0 z-*` at all and the avatar positioned
  absolutely ends up on top.
Likely related to `AppLayout` / `TopBar` z-index scale not being
consistent across all pages (P3-8 `useLiveSync` is in AppLayout — may
have shifted DOM).
**Likely fix area:** `AppLayout.tsx` + page-specific headers in
`GroupDetailHeader.tsx`, `RecipeListPage.tsx`, `GroupListPage.tsx`.
Standardise z-index tokens (use the project's `z-10`/`z-20`/`z-30`/`z-50`
scale from CLAUDE tokens).
**Priority:** high (blocks primary navigation tap-targets)

---

## BUG-006 · "Zufall" button overflows viewport on group detail page
**Reported:** 2026-04-19
**Status:** `[x] fixed` (2026-04-19 — `GroupFilterBar.tsx` search-`<label>`
got `min-w-0` added next to its `flex-1`. Without `min-w-0` a flex item's
default `min-width: auto` resolves to its intrinsic content width — for
the search `<input>` that's the placeholder ("Rezept oder Zutat suchen…"),
which forced the row wider than the 375px mobile viewport and pushed the
trailing red Zufall button off-screen. Adding `min-w-0` lets `flex-1`
shrink below the placeholder width so the row collapses cleanly and all
three controls (search + Filter + Zufall) stay inside the viewport. No
desktop regression — at >=768px the row already has plenty of horizontal
budget. Regression test in `GroupFilterBar.test.tsx` greps the search
container's className for `min-w-0` so a future refactor that drops it
re-trips the test.)
**Where:** Group detail page (`/groups/:id`) — the red "Zufall"
(random-recipe) button extends off the right edge of the screen on
mobile viewports.
**Symptom:** Button is partially cut off / invisible. User can't tap
the right-hand side of the button (or the action at all on very narrow
viewports).
**Suspected cause:** Fixed/absolute positioning with `right: -N` or a
`w-full` container overflowing its parent. Possibly also a flex/grid
layout where the button has no `shrink` or no `max-w` on container.
**Likely fix area:** `apps/web/src/features/groups/GroupDetailPage.tsx`
or wherever the "Zufall"/random-recipe-picker button is rendered.
Check for `overflow-hidden` missing on parent + `right-0` instead of
`right-4` style issues.
**Priority:** medium (button still reachable partially; feature not
blocked but looks broken)

---

## BUG-007 · "Wochenplan"-Navigation zeigt noch Phase-3-Placeholder
**Reported:** 2026-04-19
**Status:** `[x] fixed` (2026-04-19)
**Where:** Zwei Stellen nicht mit der fertigen MealPlanPage verdrahtet:
1. **`apps/web/src/features/stubs/WochenplanStub.tsx`** — Placeholder-
   Page an der `/wochenplan`-Route mit Headline "Wochenplan kommt in
   Phase 3" + italic tagline. Route in App.tsx zeigt noch diesen Stub.
2. **`apps/web/src/features/recipes/RecipeActionBar.tsx:50`** — Ghost-
   Button im Recipe-Detail-Footer setzt `setStatus('Wochenplan kommt in
   Phase 3.')` statt den Slot-Add-Flow zu starten.
**Symptom:** User klickt im globalen Menü auf "Wochenplan" (oder im
Recipe-Detail auf den Wochenplan-Button) → sieht "kommt in Phase 3"
obwohl Phase 3 seit v0.3.7 deployed ist.
**Likely fix:**
- **WochenplanStub**: entweder durch Redirect zu
  `/groups/{firstGroupId}/mealplan` ersetzen (bei nur 1 Gruppe), oder
  zu einer Gruppen-Picker-Page wenn mehrere. Alternativ: komplett aus
  Navigation entfernen und Zugang nur über die Gruppen-spezifische
  "Wochenplan"-Link auf `GroupDetailHeader` (wie in P3-2 implementiert).
- **RecipeActionBar**: wochenplan-button wirklich navigiert/öffnet
  AddSlotDialog prefilled mit dem Rezept (oder navigiert zu
  `/groups/{groupId}/mealplan/:currentMonday` + pending-slot via
  sessionStorage) — pattern wie die importGroupMemo-Handoff-Mechanik.
- **Tests**: `WochenplanStub.test.tsx` + `RecipeActionBar.test.tsx`
  updates — old Phase-3-Placeholder-Assertions rausnehmen + neue Flow-
  Asserts rein.
**Priority:** high (sichtbarer "not-implemented"-Look auf fertiger
Kern-Feature, sehr verwirrend nach Deploy)

---

## BUG-008 · Bottom-Bar "Neu"-Button öffnet nur Gruppen-Ansicht statt Create-Picker
**Reported:** 2026-04-19
**Status:** `[x] fixed` (2026-04-19 — `BottomNav` "+ Neu"-FAB öffnet jetzt
`<CreateActionSheet>` mit 5 Aktionen: Rezept manuell, URL-Import,
Foto-Import, Chat, neue Gruppe. 0 Gruppen → nur "Neue Gruppe", 1 Gruppe
→ Direkt-Link zu `/groups/{id}/recipes/new`, mehrere → Routing über
`/groups`. Regression-Tests in `BottomNav.test.tsx`)
**Where:** Bottom-Navigation-Bar "Neu"-Button
**Symptom:** Tap auf "Neu" navigiert einfach zur Gruppen-Ansicht. User
erwartet stattdessen ein Action-Sheet / Dialog / Overlay mit Auswahl
"Was willst du neu anlegen?":
- Neues Rezept (manuell)
- Rezept aus URL importieren (Video/Blog)
- Rezept aus Fotos importieren
- Rezept aus Chat generieren
- Neue Gruppe anlegen
- Evtl. auch: Wochenplan-Slot hinzufügen
**Likely fix area:** `apps/web/src/components/layout/BottomNav.tsx`
(oder wherever the bottom-bar lives) — "Neu"-Button öffnet einen
`CreateActionSheet` (mobile-native-style sheet from bottom OR shadcn
Dialog). Auswahl navigiert zum entsprechenden Create-Flow.
**Considerations:**
- Wenn User in keiner Gruppe ist → nur "Gruppe anlegen" anbieten.
- Wenn User in einer Gruppe ist → alle Optionen zeigen, Rezept-Create
  verlinkt zu `/groups/{currentGroup}/recipes/new`.
- Wenn User in mehreren → Group-Picker davor (wie P2-7 importGroupMemo).
**Priority:** high (primärer Create-CTA ist der offensichtlichste Weg
für User um neue Inhalte anzulegen — aktuell sackt die Erwartung ab)

---

## BUG-009 · Import-Seite content-area läuft rechts aus dem Viewport
**Reported:** 2026-04-19
**Status:** `[x] fixed` (2026-04-19 — `<main>` auf `ImportUrlPage` und
`ImportProgressPage` cappt jetzt mit `overflow-hidden` zusätzlich zu
`max-w-2xl`. URL-`<input>` bekommt `max-w-full min-w-0` damit eine
gepastete 1k-char-URL die Form nicht über die Viewport-Breite drückt.
Inline-Error-Banner (URL-Page) wickelt mit `break-all` damit eine
URL im server-Error-Text wrapped statt zu überlaufen.
`PhaseDetailCard` sub-line bekommt `break-all` (errorMessage enthält
oft eine lange URL/Stacktrace) und primary `break-words`.
`OverallProgressBar` Label `min-w-0 break-words` + Prozent-Span
`flex-none`. 2 Regression-Tests in `ImportUrlPage.test.tsx` +
1 in `ImportProgressPage.test.tsx` asserten classes + No-w-screen.)
**Where:** URL-Import-Seite (wahrscheinlich `/import/url` oder
`/imports/{id}`) auf mobile
**Symptom:** Content-Bereich ist zu breit — irgendwas läuft rechts
aus dem sichtbaren Bereich raus. Horizontal-scroll oder abgeschnittene
Inhalte.
**Suspected cause:** Fehlendes `max-w-full` / `overflow-hidden` auf
einem Container; oder ein `<input>` / `<pre>` / langer URL-String ohne
`break-all`/`truncate`; oder ein `w-screen` / `vw` Wert der auf mobile
zu groß wird.
**Likely fix area:**
- `apps/web/src/features/imports/ImportUrlPage.tsx`
- `apps/web/src/features/imports/ImportProgressPage.tsx`
- Prüfen auf lange URLs + Thumbnail-URLs die nicht umgebrochen werden
**Priority:** medium (UI-Polish, nicht functionality-blocking)

---

## BUG-010 · Fehlt: Übersicht aller laufenden/geplanten Imports
**Reported:** 2026-04-19
**Status:** `[x] fixed` (2026-04-19 — neuer Backend-Endpoint
`GET /api/imports?mine=true&limit=N` (capped bei 100) liefert eine
leichte `ImportSummary`-Liste (Id, GroupId, Status, Phase, Progress,
ProgressLabel, SourceUrl, CreatedAt, CompletedAt, Error) scoped auf
die Imports des Aufrufers in Gruppen, in denen er noch Mitglied ist,
newest-first sortiert. Neue Route `/rezepte/import` (vor
`/rezepte/import/:importId` registriert) zeigt eine `ImportListPage`
mit drei Create-CTAs (URL / Fotos / Chat) + Liste inkl. Source-Icon
(Video/Image/MessageSquare), Status-Chip, Progress-Bar (nur Queued/
Running), verkürzter Source-URL + relativer Zeit via
`Intl.RelativeTimeFormat` (kein neues Paket). Click-Verhalten: Done →
`/groups/{groupId}/recipes/new?importId=…` (Form-Prefill, mirrored
aus `ImportProgressPage`); sonst → `/rezepte/import/{importId}`
(shared Progress-Page). `CreateActionSheet` bekommt einen zusätzlichen
"Imports ansehen"-Eintrag. Regression-Tests: 8 Backend-Tests
(`ListMineImports…`) + 9 Frontend-Tests (`ImportListPage.test.tsx` +
`formatRelativeTime`) + 4 Wire-Mapper-Tests in `importsApi.test.ts`
+ 1 Shared-DTO-Typ-Test.)
**Where:** Video-Import-Seite — User möchte eine Übersicht sehen
**Symptom/Anforderung:** Aktuell navigiert der User nach Klick auf
"Importieren" zur ImportProgressPage eines einzelnen Imports. Wenn er
die Seite verlässt und später zurückkommt, weiß er nicht mehr welche
Imports gerade laufen oder fehlgeschlagen sind.
**Feature-Request:** Auf der Import-Landing-Page (oder einem neuen
`/imports`-Index) eine Liste aller eigenen Imports der letzten Tage
anzeigen:
- Status (Queued / Running / Done / Error)
- Phase (nach PV1-3 wenn live: Download X% / Transkription Y% ...)
- Source-URL (verkürzt)
- Erstellt vor N Minuten/Stunden
- Click → ImportProgressPage für Details + Re-navigate zum erzeugten
  Rezept falls Done
**Likely fix area:**
- Neuer Endpoint `GET /api/imports?mine=true&limit=20` (gibt's evtl.
  schon teilweise — prüfen)
- Neue `ImportListPage` Component, Tabellen-/Listen-View
- Eintrag in Bottom-Nav "Import" sollte zu dieser Liste führen, nicht
  direkt zum Create-Flow (der Create-Flow bleibt ein Button auf der
  Liste)
**Priority:** medium (UX-Lücke, besonders relevant weil PV-Slice ja
gerade detaillierten Progress ergänzt — da will man die Imports ja
auch im Überblick sehen)

---

## BUG-011 · Foto-Import failed 422 "python extractor returned http 422"
**Reported:** 2026-04-19 (user tested with 2 photos)
**Status:** `[x] fixed` (2026-04-19 — `ExtractRecipeFromPhotosJob`
absolutiziert path-absolute Foto-URLs (`/api/photos/...?sig=...&exp=...`)
mit `App:FrontendBaseUrl` Prefix bevor sie an Python gehen. Pydantic
HttpUrl validiert wieder + Azure Vision kann die URLs öffentlich fetchen.
8 neue Regressions-Tests: 5 .NET (`BUG011_*` in `ExtractRecipeFromPhotosJobTests`,
inkl. backward-compat für bereits-absolute URLs + Theory für die
URL-Promotion + Reject-Tests) + 2 Python (`test_extract_photos_endpoint`:
relativ→422, absolut→200))
**Severity:** CRITICAL — complete photo-import pipeline broken in prod
**Symptom:** User lädt 2 Fotos hoch, klickt Import, Hangfire-Job failed
mit `python extractor returned http 422`. Prod-Logs bestätigen:
`POST /extract/photos HTTP/1.1" 422 Unprocessable Content`.

**Root cause (diagnostiziert):**
`ExtractPhotosRequest` in Python (`apps/python-extractor/src/extractor/main.py:115`)
deklariert `photo_urls: list[HttpUrl]`. Pydantic `HttpUrl` ist strict
und akzeptiert NUR absolute URLs mit `http[s]://`-Schema — rejected
relative Paths wie `/api/photos/recipes/{id}?sig=...&exp=...`.

Der Flow:
1. Frontend `ImportPhotosPage.tsx:210` sendet `photoUrls: signedUrls`
2. .NET `IsSignedPhotoUrl` akzeptiert **sowohl relative als auch
   absolute** Shapes (Zeile 329-347)
3. .NET `ExtractRecipeFromPhotosJob` forwarded die URLs UNVERÄNDERT an
   Python (`photo_urls = photoUrls`)
4. Wenn Frontend relative Paths (`/api/photos/...`) sendet → Python
   pydantic 422

**Zusätzliches Problem**: Selbst wenn die URLs absolute wären
(`https://EXAMPLE_HOST/api/photos/...`), muss Azure Vision sie
fetchen können — unsere signed URLs sind zwar über Caddy public
erreichbar, aber Azure OpenAI braucht vermutlich extra SAS-URL-Pattern
oder eingebettete Bilder. Vermutlich war dieser Flow **nie end-to-end
getestet** (`test_vision_live.py` ist skip-by-default).

**Likely fix:**
- **Kurzfristig**: .NET baut absolute URLs mit `CADDY_DOMAIN` prefix
  bevor es an Python geht. Python pydantic schluckt dann den Request.
- **Mittelfristig**: Ende-zu-Ende-Test mit realer Azure Vision und
  echten öffentlichen Foto-URLs (der `test_vision_live.py` endlich mal
  scharf schalten + CI-Env-Gate).
- **Möglicherweise** Azure Vision braucht base64-eingebettete Bilder
  statt URLs — check Azure Vision API docs für das aktuelle gpt-4.1
  vision-format.

**Likely fix areas:**
- `apps/api/src/FamilienKochbuch.Api/Jobs/ExtractRecipeFromPhotosJob.cs`
  (absolute-URL conversion)
- oder Frontend `apps/web/src/features/imports/ImportPhotosPage.tsx`
  (signedUrls absolut bauen)
- `test_vision_live.py` entpuzzeln + CI-/user-Env mit test-public-URL

**Priority:** HIGH — Foto-Import ist aktuell komplett unbenutzbar in
Prod. Fix sollte direkt nach PV1-Abschluss kommen, bevor PV2/PV3
weiterlaufen.

---

## BUG-012 · Video-Import ergibt kein Rezept (fehlendes groupId im Status-Response)
**Reported:** 2026-04-19 (user ran 3 successful URL imports, 0 recipes resulted)
**Status:** `[x] fixed` (PV4-followup, 2026-04-19 — `ImportStatusResponse`
um `GroupId` + alle Phase-Tracking-Felder erweitert; Frontend-Redirect
greift jetzt auf `data.groupId` zurück wenn `locationState` und
`sessionStorage` leer sind)
**Severity:** HIGH — primary video-import flow loses recipes silently
**Symptom:** User startet Video-Import im Frontend, Import läuft durch
(Status=Done, Progress=100, ResultJson mit strukturiertem Rezept in
DB), ABER kein Recipe wird erstellt. User sieht keine Erfolgs-
bestätigung + findet danach kein Rezept in der Liste.

**Diagnose VPS-Logs (2026-04-19):**
- 3 erfolgreiche URL-Imports heute (`2792c8fc`, `8c544cdd`, `c13efc1c`)
  alle `Status=Done, Progress=100, ResultJson` mit 3-4 KB validem JSON
- **ZERO Hits** auf `/api/groups/{g}/recipes` POST oder recipe-create
  im selben Zeitfenster → Recipe-Form-Page wurde nie erreicht

**Root cause:**
`ImportProgressPage.tsx:46-77` auto-redirect zu
`/groups/{g}/recipes/new?importId=...` hängt an `groupId`. Das wird
aus 2 Quellen gelesen:
1. `location.state.groupId` (set by `ImportUrlPage` on submit)
2. `recallImportGroup(importId)` — sessionStorage sidecar

Kommentar Zeile 40-45: "The .NET `ImportStatusResponse` intentionally
omits [groupId]". Diese Entscheidung war P2-7 — aber sie erzeugt UX-
Fragilität:
- PWA-Mobile: Memory-eviction während Background-Tab → state weg
- Browser-Reload während Running → location.state weg, sessionStorage
  hält's meistens aber nicht garantiert
- Neuer Tab mit deep-link-URL zum Progress → kein state
- User refresht nach Deploy → in-memory state + sessionStorage gecheckt
  aber session-sort (P3-7-Fix `purgeAppSessionStorage` on logout) kann
  bei Auth-Timeout-Redirects zuschlagen

Wenn `groupId == null`: `<DoneWithoutGroupPanel />` wird angezeigt —
User muss manuell eine Gruppe wählen. Vermutlich wurde dieser Panel
aber nicht gesehen (User ging weg) ODER er ist visuell nicht klar
genug als "hier musst du noch action machen" gekennzeichnet.

**Likely fix:**
Backend `ImportStatusResponse` (`apps/api/src/FamilienKochbuch.Api/
Endpoints/ImportEndpoints.cs:26-40`) ergänzen um `GroupId: Guid` —
das feld existiert im DB-Row (`RecipeImport.GroupId`), kein Grund es
zu verstecken. Auth-check auf Owner-ship ist ja schon vorhanden.

Frontend `ImportProgressPage.useEffect` ließt dann `data.groupId`
direkt aus dem status-response statt auf locationState/sessionStorage
zu hängen. Redirect funktioniert dann immer.

`DoneWithoutGroupPanel` bleibt als belt-and-suspenders aber wird in
Praxis nie mehr erreicht.

**Priority:** HIGH — blockiert den Haupt-Flow. Test mit einem Reload
während Running reproduziert den Bug sofort.
**Related:** Die `importGroupMemo.ts` sessionStorage-Mechanik kann
beibehalten oder entfernt werden — ersteres als reines Fallback.

---

## BUG-013 · URL-Import: kein Cache bei wiederholter gleicher URL (Feature-Request)
**Reported:** 2026-04-19
**Status:** `[x] fixed` (2026-04-19 — `EnqueueUrlImportAsync` macht vor
`jobs.Enqueue` einen Pre-Lookup: gleicher Caller + gleiche canonical-URL +
`Status=Done` + `CreatedAt > now - 7 Tage` → 202 mit `{ importId, cached:
true }` zurück; keine neue Hangfire-Job-Enqueue, kein Whisper/Azure-
Aufruf. `Force: true` im Request-Body (`UrlImportRequest`) umgeht den
Cache und erzeugt immer eine frische Extraktion. URL-Kanonisierung via
neuem `UrlNormaliser.Normalise` (lowercase scheme+host, strip tracking
params `fbclid`, `gclid`, `mibextid`, `_ga`, `ref_src`, `ref_url`,
`igshid`, `si`, `feature` + alle `utm_*`, default-Port-Drop, Fragment
erhalten, Query-Order stabil) — dadurch hits gleiche FB-Reel-URL auch
nach verschiedenen Share-Sources. Persistierte `SourceUrl` ist jetzt
die kanonische Form. Frontend `ImportUrlPage` rendert bei `cached: true`
ein blaues Banner mit 2 CTAs: "Zum bestehenden Rezept" (navigate zur
Progress-Page → done-branch redirect zum Recipe-Form prefilled) +
"Neu extrahieren" (POST mit `force: true`). Scope ist per-User (privacy),
TTL 7 Tage. 16 .NET-Regressions-Tests (11 `UrlNormaliserTests` +
5 `BUG013_*` Endpoint-Tests: cache-hit, per-User-Scope, force-flag,
7-day-expiry, tracking-param-normalisation) + 3 neue Frontend-Tests
in `ImportUrlPage.test.tsx` (Banner-Render + beide CTAs). Keine neuen
NuGet-/NPM-Packages. SQLite-Test-Fallback loaded-then-filter analog zu
`SweepAbandonedStagedPhotosJob` weil EF-Core-SQLite-Provider weder
DateTimeOffset-Comparisons noch ORDER BY DateTimeOffset unterstützt.)
**Severity:** medium (UX + cost — nicht broken, nur suboptimal)
**Symptom:** User gibt zwei mal die gleiche URL ein → beide Male läuft
die komplette Pipeline (yt-dlp ~1s + Whisper ~30-90s + Azure ~3s +
Post-Process) + verbraucht Tokens. Aktuell kein Cache.
**Request:** Vor-enqueue-Check:
"Gibt's ein `RecipeImport` mit identischer `SourceUrl` UND
`Status=Done` UND (`UserId==caller` ODER in einer Gruppe die der
caller teilt) UND `CompletedAt > now() - 7 Tage`?"
→ Wenn ja: skip enqueue, gib den existierenden `importId` zurück
   mit Flag `cached: true`. Frontend zeigt sofort "Bereits gefunden:
   [Rezepttitel] — weiter zum Rezept?" + "Neu extrahieren"-Option.
**Trade-offs / considerations:**
- Scope: Per-User reicht (privacy-conscious). Per-Gruppe wäre
  mehr-invasiv (User A sieht plötzlich Inhalte die User B extrahiert
  hat ohne Zustimmung).
- TTL 7 Tage: balance zwischen "Video hat sich nicht geändert" (meist
  stimmt) vs "Prompt/Model hat sich verbessert" (selten).
- Token-Tracking: cached-hit erzeugt keinen `ChatUsageLog` — transparent
  machen ("gespart: ~X Tokens via Cache").
- **Explicit "Neu extrahieren"** Button auf Import-URL-Page → Query-
  Param `?force=true` am POST → umgeht Cache, enqueued frischen Job.
- **Edge case**: URL mit Tracking-Params — normalisieren vor Compare
  (z.B. `?fbclid=...` strippen), sonst hit-rate terrible.
**Likely fix area:**
- Backend: `ImportEndpoints.EnqueueUrlImportAsync` — pre-DB-lookup vor
  dem `jobs.Enqueue`. Response-Shape erweitern: `{ importId: Guid,
  cached: bool }`.
- Frontend: ImportUrlPage zeigt bei `cached: true` einen Preview-
  Banner mit Rezepttitel + "Weiter zum Rezept" / "Neu extrahieren"
  Buttons.
- URL-Normalisierung: lowercase host + strip common tracking params
  (`fbclid`, `utm_*`, `mibextid`, etc.) als pure helper + tests.
**Priority:** medium (spart Zeit+Kosten, aber Feature, nicht bug).
Könnte gut als eigener post-PV4-Slice kommen — PV-Scope erstmal
zuende.

---

## BUG-014 · Bottom-Nav schiebt sich beim Scrollen unter die Browser-Bottom-Bar
**Reported:** 2026-04-19
**Status:** `[x] fixed` (2026-04-19 — `BottomNav` jetzt mit
`bottom-[env(safe-area-inset-bottom,0px)]` *und* `pb-[env(safe-area-
inset-bottom,0px)]` — Anker UND Padding respektieren beide die iOS/
Android Safe-Area. `viewport-fit=cover` war bereits in `index.html`.
Regression-Test asserted beide Tailwind-Klassen am Nav-Element)
**Where:** Mobile PWA (iOS Safari + Chrome Android), alle Seiten mit
`BottomNav` (bottom navigation bar).
**Symptom:** Beim Hochscrollen schiebt sich unsere App-Bottom-Nav
teilweise unter die Browser-Bottom-Bar (Safari URL-Bar / Chrome
address-bar retraction-animation). Bottom-Nav bleibt nicht sicher
oberhalb der dynamischen Browser-Chrome-Zone.
**Related:** BUG-001 (Chat-Input hidden by mobile bottom bar) — gleicher
Root-Cause-Bereich (`100vh`/`100dvh`/`env(safe-area-inset-bottom)`
handling).
**Suspected cause:** `BottomNav` positioned mit `fixed bottom-0` ohne
`env(safe-area-inset-bottom)` padding. iOS/Android browsers animieren
die URL-Bar rein/raus beim Scrollen; wenn die App-Nav fix `bottom:0`
ist, überlappt sie zwischendurch mit der erscheinenden Browser-Chrome.
**Likely fix area:**
- `apps/web/src/components/layout/BottomNav.tsx` (oder wo die Nav
  lebt)
- Verwenden: `bottom-[env(safe-area-inset-bottom,0px)]` + `pb-[env(safe-area-inset-bottom,0px)]`
- ALTERNATIV: `position: sticky; bottom: 0;` statt `fixed` — dann folgt
  die Nav dem Dokument-Flow und wird nicht vom Browser-Chrome
  übermalt. Trade-off: `sticky` kann in Verbindung mit `overflow`
  Parents verschwinden.
- Viewport-meta prüfen: sollte `viewport-fit=cover` enthalten damit
  `env(safe-area-inset-*)` überhaupt Werte liefert.
- Empfehlung: gleichzeitig mit BUG-001 + BUG-005 (z-index scaling)
  als eine gebündelte "Mobile-Chrome-Audit"-Session — touch-target +
  safe-area + z-index alles prüfen, da die Probleme zusammenhängen.
**Priority:** medium (nicht blockierend, aber UX-polish für PWA)
**Test-Strategie:** Playwright-mobile-emulation mit iOS + Android
Safari/Chrome viewports — visueller assertion auf Bottom-Nav-Position
nach scroll. Alternativ: unit-test auf computed-style des `bottom`-
Werts wenn `safe-area-inset-bottom` via CSS-Variable gemockt wird.

---

## BUG-015 · Foto-Import: Nur Kamera, keine Mediathek-Auswahl
**Reported:** 2026-04-19 (mobile iOS/Android)
**Status:** `[x] fixed` (2026-04-19 — `ImportPhotosPage.tsx` split into
two hidden inputs (`photos-camera-input` w/ `capture="environment"` +
`photos-gallery-input` w/o capture) plus two explicit Lucide-icon
buttons "Kamera" / "Fotos auswählen" sharing the same staging handler.
3 regression tests added.)
**Where:** Photo-Import-Page (`/rezepte/import/photos` oder ähnlich),
Upload-Button / file-picker für Fotos.
**Symptom:** Auf mobile kann der User nur die **Kamera** öffnen zum
Foto machen, aber NICHT aus der Mediathek ein existierendes Foto
auswählen. Der System-Picker zeigt direkt die Kamera-App statt den
Fotos-Picker.
**Suspected cause:** `<input type="file" accept="image/*" capture=...>`
hat wahrscheinlich `capture="environment"` oder `capture="user"`
gesetzt — das zwingt iOS/Android den System-Picker zur Kamera zu
öffnen, statt die Mediathek anzubieten.
**Likely fix area:**
- `apps/web/src/features/imports/ImportPhotosPage.tsx` oder das
  darunter verwendete `PhotoUploadGrid`-Component
- Check: `capture` attribute — sollte **weggelassen** werden wenn beide
  Optionen angeboten werden sollen (User erhält dann System-Picker mit
  "Fotomediathek / Datei auswählen / Foto machen" — standard behavior).
- Optional für bessere UX: zwei separate Buttons — "Kamera"
  (`capture="environment"`) + "Mediathek" (kein capture, nur `accept`).
**Alternative fix**: zwei getrennte Buttons:
```tsx
<input type="file" accept="image/*" capture="environment" /> {/* Kamera */}
<input type="file" accept="image/*" multiple />              {/* Mediathek */}
```
Mit verschiedenen Labels "📷 Kamera" / "🖼️ Mediathek".
**Priority:** HIGH — Nutzer kann bestehende Fotos (z.B. Kochbuch-Scan
den er vor Tagen gemacht hat) nicht importieren. Nur live-Kamera-
Nutzung aktuell möglich. Blockiert ein primäres Use-Case.
**Test-Strategie:** Vitest-Component-Test: render Photo-Upload, assert
dass `input[type=file]` KEIN `capture` attribute hat, oder falls zwei
separate Inputs: assert beide vorhanden mit entsprechend
unterschiedlicher Config. Plus Snapshot damit es nicht versehentlich
zurückkommt.

---

## BUG-016 · Deploy v0.4.0: docker-network DNS kaputt nach Subnet-Change (recovery-flow needed)
**Reported:** 2026-04-19 (post v0.4.0 deploy — prod crashed ~2 min)
**Status:** `[x] fixed` (2026-04-19 — `deploy.yml` "Pull + restart"-Step
vergleicht jetzt sha256 von `docker-compose.prod.yml` gegen
`/srv/familien-kochbuch/.last-compose-hash`. Bei Diff: `compose down`
vor `up -d` → Docker baut Network + embedded-DNS komplett neu, kein
SERVFAIL mehr. Reine Image-Updates bleiben zero-downtime. Recovery-
Runbook in `docs/ops.md §7.1`. Regressions-Test:
`scripts/verify-deploy-workflow.sh` asserted dass `.last-compose-hash`
+ `compose down` + `sha256sum` im deploy.yml präsent bleiben.)
**Severity:** operational — deploy succeeded at GHA-level but api container
crash-looped bis manual intervention.
**Symptom:** PV1 hatte `networks.default.ipam.config.subnet: 172.28.0.0/16`
ergänzt (docker-compose pin). Nach deploy.yml "docker compose up -d":
- Docker migrated containers ins neue subnet (alle 172.28.0.2-8)
- **ABER**: embedded-DNS (127.0.0.11) konnte Container-Hostnames NICHT
  mehr auflösen — `nslookup postgres` from JEDEM container → SERVFAIL
- api crashed beim Boot weil Hangfire `UsePostgreSqlStorage` im DI-init
  `NpgsqlConnection.Open()` machte → DNS resolution failed → SIGSEGV
  (exit 139) → restart-loop
**Mitigation applied:** `docker compose -f ... down` + `up -d` →
Network wurde komplett neu gebaut → DNS repariert → alle Container
healthy. **Downtime**: ~2-3 min bis manuelle Intervention.
**Root cause insight:** Docker's `compose up` mit geänderter Netzwerk-
IPAM-Config migriert bestehende Container OHNE das embedded-DNS-state
zu refreshen. Bug / undocumented behavior. Compose `down`+`up` ist der
sichere Weg bei Network-Config-Änderungen.
**Likely fix (deploy.yml enhancement):**
Erweitere den SSH-deploy-step um eine Hash-Compare-Logik:
```bash
# Compute hash of docker-compose.prod.yml
NEW_HASH=$(sha256sum /srv/familien-kochbuch/docker-compose.prod.yml | cut -d' ' -f1)
LAST_HASH=$(cat /srv/familien-kochbuch/.last-compose-hash 2>/dev/null || echo "")
if [ "$NEW_HASH" != "$LAST_HASH" ]; then
    echo "compose file changed → full recreate"
    docker compose -f docker-compose.prod.yml down
fi
docker compose -f docker-compose.prod.yml up -d
echo "$NEW_HASH" > /srv/familien-kochbuch/.last-compose-hash
```
Trade-off: 20-30s downtime bei compose-file-Changes vs. zero-downtime
bei reinen Image-Updates. Selten passiert + macht Infra-Bugs vermeidbar.
**Priority:** medium (one-off-scenario, aber würde vergleichbare
Vorfälle künftig verhindern)
**Test-Strategie:** Deploy-workflow-simulation via `act` (GH Actions
local runner) mit compose-file-Change + zweiter Deploy ohne Change →
assert dass down+up nur beim ersten fires. Oder: simpler Shell-Test
des Hash-Compare-Blocks. Docs-only Fallback: Runbook in docs/ops.md
mit "Wenn Prod post-deploy rot ist: ssh + `compose down && up -d`".
**Add to docs/ops.md**: dedicated recovery section für diesen Fall.

---

## BUG-017 · Recipe-Form nach Auto-Redirect leer (Race Condition)
**Reported:** 2026-04-19 (user tested post-v0.4.0)
**Status:** `[x] fixed` (2026-04-19 — commit 97e8fd8: wrapper blockiert
`RecipeFormInner` mit `<LoadingSpinner />` solange `status === 'done'`
aber `result == null`, ebenso bei `status === 'error'`. Component-
Regressions-Test deckt beide Race-States ab.)
**Severity:** HIGH — blockiert primary video-import UX
**Symptom:** Nach Video-Import Done → Auto-Redirect zu
`/groups/{g}/recipes/new?importId=X` → **Form komplett leer**.
ABER: wenn User dieselbe URL manuell/bookmarked öffnet → Form IST
prefilled.
**Root cause:** `RecipeFormInner` verwendet `useState(prefill?.title ?? '')`
als initialisizer. `prefill` wird im Wrapper aus
`importQuery.data?.result` berechnet. Beim Auto-Redirect-Pfad hat die
TanStack-Cache evtl. einen transient-state wo `status === 'done'`
(erforderlich um redirect zu triggern) ABER `result` null ist —
SignalR-`setQueryData`-Merges können cache touchen ohne result zu
setzen. Wrapper rendert Inner mit `prefill === undefined` → useState
committed leere values → spätere rerender mit populated prefill
UPDATEN useState NICHT (nur initial wird einmalig evaluiert).
**Likely fix (im Wrapper vor Inner-Render):**
```tsx
if (importId && importQuery.isLoading) return <LoadingSpinner />
// NEW: block Inner-render bis result tatsächlich da ist
if (importId && importQuery.data?.status === 'done' && !importQuery.data.result) {
  // Cache hat done aber noch kein result — warte auf next poll
  return <LoadingSpinner />
}
// Optional: handle error state explicitly
if (importId && importQuery.data?.status === 'error') {
  return <ErrorPanel message={importQuery.data.errorMessage} />
}
```
**Test-Strategie:** Component-Test: render RecipeFormPage mit
importId + seedCache({status:'done', result:null}) → assert
LoadingSpinner rendered, nicht leeres Form. Dann seed mit
{status:'done', result:{...}} → assert form prefilled. 
Zusätzlich: Integration-Test: simulate auto-redirect path mit
SignalR-event + polling-race → assert Inner rendert EINMAL mit
vollem prefill.

---

## BUG-018 · Video-Thumbnail wird nicht als Recipe-Photo attached
**Reported:** 2026-04-19 (feature-request)
**Status:** `[x] fixed` (2026-04-19 — `ExtractRecipeFromUrlJob` ruft nach
`MarkDone` einen neuen `ThumbnailAttacher`-Service auf, der die
extrahierte `recipe.thumbnail_url` (yt-dlp Frame) gegen eine
SSRF-Host-Allowlist (*.fbcdn.net, *.cdninstagram.com, *.tiktokcdn.com,
*.ytimg.com, etc.) prüft, mit 5s-Timeout + 5MB-Cap + image/* MIME-Check
herunterlädt, via `IPhotoStorage.UploadAsync` in SeaweedFS persistiert,
einen `StagedPhoto`-Row anlegt und über das neue domain-Feld
`RecipeImport.ThumbnailStagedPhotoId` (EF-Migration
`AddRecipeImportThumbnailStagedPhotoId`, nullable) verlinkt. Alle
Download-Failures (Timeout, 4xx/5xx, oversize, non-image, host-reject)
loggen Warning + lassen das Recipe trotzdem fertig werden — nie
exception-bubbling. Frontend: `ImportStatusResponse` exposed
`thumbnailStagedPhotoId`, `RecipeFormPage`-Wrapper foldet sie via
`withImportEnvelope` in die `stagedPhotoIds`, die zum POST
`/api/recipes` durchgereicht werden — PF1-promote-flow adoptiert das
Foto auf dem gespeicherten Rezept. 15 .NET-Regressionstests in
`ExtractRecipeFromUrlJobTests.BUG018_*` (Happy-Path, CDN-500,
oversize-Content-Length, non-image-MIME, no-thumbnail-Result,
disallowed-host, plus 9 host-allowlist InlineData-Cases) +
7 Web-Tests (`importPrefill.test.ts` × 3, `importsApi.test.ts` × 2,
`RecipeFormPage.test.tsx` × 2). Keine neuen NPM/NuGet-Packages.)
**Severity:** LOW (feature-request, nicht bug)
**Symptom:** Nach Video-Import hat das Rezept keine Fotos. User
erwartet mindestens den Video-Thumbnail als Recipe-Hero-Image.
**Current**: `ExtractedRecipe.thumbnail_url` wird von yt-dlp gezogen
(z.B. `https://scontent-fra3-2.xx.fbcdn.net/...`), landet auch im
`ResultJson`, aber RecipeFormPage/Inner zieht ihn nicht in die
PhotoUploadGrid.
**Likely fix**:
- Backend: neuer Step im `ExtractRecipeFromUrlJob` der den
  `thumbnail_url` downloaded + via `IPhotoStorage` als SeaweedFS-
  Objekt speichert + das Recipe-Row auf `thumbnail_photo_id` referenzing
  setzt ODER als Staged-Photo via PF1 promote-flow anhängt.
- Frontend: prefill berücksichtigt `thumbnail_url` + zeigt ihn als
  Staged-Photo im PhotoUploadGrid; user kann ihn löschen wenn nicht
  gewünscht.
- Edge: FB-CDN-URLs können ablaufen — beim Import-done-Zeitpunkt
  sofort downloaden + persist, nicht nur URL referenzieren.
**Priority:** LOW (nice-to-have); größerer Scope — braucht neue
Download-Logic + Staged-Photo-Integration. Eigener kleiner Slice
"IMPORT-THUMB" post-Bug-Sweep.
**Test-Strategie:** E2E-Test mit einem bekannten public Video-URL,
assert dass nach Import das Recipe mindestens 1 Photo hat.

---

## BUG-019 · Such-Placeholder läuft aus dem Input-Feld heraus (GroupFilterBar)
**Reported:** 2026-04-20
**Status:** `[x] fixed` (2026-04-20 — responsive placeholder via `useIsMobile` — `"Suchen…"` on mobile, full `"Rezept oder Zutat suchen…"` on md+; `aria-label` stays `"Suche"`)
**Severity:** low (kosmetisch, kein Funktionsverlust — Input funktioniert,
sieht nur abgeschnitten aus auf schmalen Viewports)
**Where:** `apps/web/src/features/groups/GroupFilterBar.tsx:57` —
Gruppen-Detail-Seite, DS4-Filter-Bar
**Symptom:** Placeholder `"Rezept oder Zutat suchen…"` wird auf
schmalen Viewports (~≤390 px) abgeschnitten / läuft rechts aus dem
Input-Rahmen heraus. Tritt auf, weil der Suchfeld-Block `flex-1` +
`min-w-0` ist (aus BUG-006-Fix, damit Filter- und Zufall-Buttons im
Viewport bleiben) — der Shrink-below-content ist funktional korrekt,
aber der Text wirkt visuell "abgehackt".
**User-Vorschlag:** Suchfeld auf eigene Zeile (stacked layout unter
Filter + Zufall-Buttons).
**Likely fix — 3 Optionen zur Wahl:**
1. **Stacked layout auf Mobile** (user-Vorschlag, grösster Redesign-
   Hub): GroupFilterBar wird auf `flex-col md:flex-row`; Suchfeld
   `w-full` oben, Filter + Zufall `flex-row gap-2.5` darunter. Pro:
   maximaler Platz fürs Placeholder, klare Hierarchie. Kontra: zweite
   Row kostet vertikalen Raum auf Mobile, wo `sticky top-*` Header
   bereits ~120 px belegt.
2. **Kürzerer Placeholder** (1-Zeilen-Fix): `"Suchen…"` statt
   `"Rezept oder Zutat suchen…"`. Pro: minimal-invasiv, Layout bleibt
   wie heute. Kontra: weniger selbst-erklärend — User muss den `aria-
   label="Suche"` + Magnifier-Icon benutzen um zu wissen dass auch
   nach Zutaten gesucht werden kann.
3. **Responsive Placeholder** (Kompromiss): `useIsMobile()`-Hook
   schaltet Placeholder-Text um — `"Suchen…"` auf Mobile,
   `"Rezept oder Zutat suchen…"` ab md-Breakpoint. Pro: kein
   Layout-Change, kein Info-Verlust auf Desktop. Kontra: hint über
   Zutaten-Suche fehlt trotzdem auf Mobile (man könnte als Compensation
   nach 2-3 s idle Toast/Hint einblenden, aber Scope-Creep).
**Priority:** LOW — kosmetisch, GroupDetailPage ist noch deutlich
funktional. Bundle-Kandidat mit weiterer Mobile-Polish-Welle.
**Test-Strategie:** Component-Test `GroupFilterBar.test.tsx` mit
viewport 375 × 667 (iPhone SE), assert dass `input.placeholder`-Text
entweder in-input-fits (measure via `scrollWidth <= clientWidth`) oder
— bei stacked layout — auf eigener Zeile rendert (parent hat
`flex-direction: column` via computed-style). CSS/Layout-Bug → grep +
computed-style assertion laut Regression-Test-Policy.

---

## BUG-020 · Zwei identische Cog-Icons im Gruppen-Header (Tags vs. Einstellungen)
**Reported:** 2026-04-20
**Status:** `[x] fixed` (2026-04-20 — tag-management extracted to `GroupTagsPanel`, mounted as last section of `GroupSettingsPage` with `id="tags"`, top-bar cog removed from `GroupDetailPage`, `/groups/:id/tags` redirects to `/groups/:id/settings#tags` with smooth scroll)
**Severity:** medium (UX — navigation-confusion, nicht funktional kaputt)
**Where:**
- `apps/web/src/features/groups/GroupDetailPage.tsx:200-206` — kleiner
  Cog-Button oben rechts im Gruppen-Top-Bar, navigiert nach
  `/groups/{id}/tags`. **Wichtig:** Button hat aktuell
  `aria-label="Einstellungen"` obwohl er auf Tags-Seite zeigt — doppelt
  verwirrend für Screenreader-User.
- `apps/web/src/features/groups/GroupDetailHeader.tsx:100-103` —
  "Einstellungen"-Button unten im Group-Header-Card, navigiert nach
  `/groups/{id}/settings`. Gleiches `lucide-react/Settings`-Icon.
**Symptom:** User sieht **zwei Zahnräder** direkt untereinander auf
derselben Seite, beide mit Tooltip/Label "Einstellungen"-ähnlich. Ein
Klick geht zur Tag-Verwaltung, der andere zur Gruppen-Settings-Seite
(Name / Beschreibung / Foto / Mitglieder). Keine visuelle Unterscheidung.
**User-Vorschlag:** Tag-Verwaltung als Section ans Ende der
`GroupSettingsPage` anhängen und den Tag-Cog-Button in der Top-Bar
entfernen — ein einziger Einstellungs-Einstieg pro Gruppe.
**Likely fix — 3 Optionen zur Wahl:**
1. **Tag-Verwaltung in GroupSettingsPage integrieren** (user-Vorschlag,
   empfohlen): Die bestehende `/groups/{id}/tags`-Route rendert einen
   `GroupTagsPanel`-Inhalt (CRUD der gruppen-eigenen Tags). Diesen als
   letzte Section in `GroupSettingsPage` einfügen (nach Mitglieder +
   Einladungen). Route `/groups/{id}/tags` bleibt kompatibel, rendert
   aber eine Redirect- oder Deep-Anchor-Navigation (`#tags`) nach
   `/groups/{id}/settings`. Top-Bar-Cog in `GroupDetailPage.tsx`
   entfernen, die `GroupDetailHeader`-Einstellungen-Pill bleibt einzige
   Anlaufstelle. Pro: ein mentaler Ort für "alles zur Gruppe"; eine
   Info-Architektur-Aufräumung. Kontra: längere Settings-Seite —
   Nutzer mit vielen Custom-Tags scrollen.
2. **Icons ausdifferenzieren** (minimal-invasiv): Cog-Button für Tags
   bleibt, bekommt aber `lucide-react/Tags`- oder `Tag`-Icon (Etikett-
   Symbol), `aria-label="Tags verwalten"`. Pro: kein Routing-Refactor.
   Kontra: löst die UX-Frage "zwei Einstellungs-Einstiege" nicht —
   Tags-Button bleibt prominent im Header obwohl er funktional eine
   Einstellungs-Section ist.
3. **Tags in einen Overflow-Menü-Eintrag verschieben** (kompromiss):
   Top-Bar-Button wird zu einem `MoreVertical`-3-Dots-Menü mit
   Einträgen "Tags verwalten" + (später) weitere Power-User-Actions.
   Einstellungen-Pill im GroupDetailHeader bleibt primär. Pro:
   skaliert für künftige Actions. Kontra: dritter Navigation-Style
   auf einer ohnehin dichten Seite.
**Priority:** medium — Information-Architecture-Fix lohnt sich, weil
Tags-CRUD-Fläche eh klein ist (typisch &lt;10 Custom-Tags pro Gruppe)
und gut in die Settings-Seite passt. Bundle-Kandidat mit einer
Settings-Seiten-Sektionierung (Collapsible-Sections analog
`MobileDayStack` aus P3-10).
**Test-Strategie:** Frontend-UX-Bug → Component-Test + Integration:
- `GroupDetailPage.test.tsx`: assert dass Top-Bar keinen zweiten
  Cog-Link mehr rendert (`queryByRole('link', { name: /einstellungen/i })`
  liefert genau **einen** Match — den GroupDetailHeader-Pill).
- `GroupSettingsPage.test.tsx`: assert dass die Tag-Verwaltungs-Section
  mit Heading "Tags" + existing tag-CRUD-Controls rendert.
- Route-Redirect-Test: `/groups/{id}/tags` → navigiert zu
  `/groups/{id}/settings#tags` (deep-anchor) oder rendert die
  zusammengeführte Seite mit `scrollIntoView` auf die Tag-Section.

---

## BUG-021 · RecipeActionBar rutscht beim Scrollen unter die BottomNav
**Reported:** 2026-04-20
**Status:** `[x] fixed` (2026-04-20 — Option 1 umgesetzt: neuer CSS-Token `--bottom-nav-height` in `index.css` bündelt `env(safe-area-inset-bottom)+56px` als Single-Source-of-Truth für den BottomNav-Footprint. `RecipeActionBar` bekommt `z-40` (über BottomNavs `z-30`) und offset `calc(var(--bottom-nav-height)+env(safe-area-inset-bottom,0px))`, wodurch das BUG-014-Double-Safe-Area jetzt sauber mitberechnet wird. Notifier analog auf `z-[41]` + gleichen Offset-Stamm gehoben. Regressions-Gates: Component-Test prüft `z-40` im Klassen-String, zwei Grep-Tests verbieten wiedereingeführtes `z-\[[0-9]\]` bzw. das alte `72px`-Literal in `RecipeActionBar.tsx`, und ein Grep-Test in `BottomNav.test.tsx` gatet den `--bottom-nav-height`-Token in `index.css` gegen versehentliches Entfernen.)
**Severity:** HIGH — blockiert "Jetzt gekocht" + "In Wochenplan" CTAs auf
Mobile. Das sind die primären Aktionen der Rezept-Detail-Seite.
**Where:** `apps/web/src/features/recipes/RecipeActionBar.tsx:76-119`
(ActionBar) + `apps/web/src/components/layout/BottomNav.tsx:56`
(BottomNav).
**Symptom:** Auf Rezept-Detail-Seite sitzen zwei Buttons ("In Wochenplan"
+ "Jetzt gekocht") in einer fixed-bottom Bar knapp über der
BottomNav. Beim Scrollen (speziell iOS Safari mit dynamischer
Toolbar) wandern die Buttons visuell **unter** die BottomNav und sind
nicht mehr klickbar.
**Root cause (vermutet, 2 Faktoren):**
1. **z-Index-Mismatch:** RecipeActionBar hat `z-[8]`, BottomNav hat
   `z-30`. Bei jeder Überlappung gewinnt die BottomNav → ActionBar
   verschwindet unter ihr statt davor.
2. **Bottom-Offset zu knapp berechnet:** ActionBar positioniert sich
   via `bottom-[calc(env(safe-area-inset-bottom,0px)+72px)]`. BUG-014
   hat die BottomNav auf `bottom-[env(safe-area-inset-bottom)]` +
   `pb-[env(safe-area-inset-bottom)]` gesetzt — das zählt den
   Safe-Area-Inset zweimal + ~56 px Content-Höhe. Auf iPhone mit
   Safe-Area-Inset ~34 px ist die BottomNav effektiv **90 px** hoch
   (34 + 56), aber die ActionBar springt nur 72 px nach oben → 18 px
   Überlappung. Ruckelt beim Scrollen weil iOS die Safe-Area-Inset-
   Werte während der Adressleisten-Retraktion neu berechnet und die
   beiden fixed-Elemente unterschiedlich schnell repainten.
**Likely fix — 3 Optionen:**
1. **Beide Faktoren fixen** (empfohlen): ActionBar `z-[8]` → `z-40`
   (über BottomNav `z-30`), UND bottom-offset korrigieren auf
   `bottom-[calc(env(safe-area-inset-bottom,0px)+92px)]` (34 Inset +
   56 Nav-Höhe + 2 px Luft). Oder — sauberer — zentrale CSS-Variable
   `--bottom-nav-height: calc(env(safe-area-inset-bottom,0px) + 56px)`
   in `index.css` definieren und beide Stellen (BottomNav sizing,
   ActionBar offset) darauf referenzieren. Einmalige Quelle der
   Wahrheit, fliegt nicht mehr auseinander wenn Nav-Höhe geändert
   wird.
2. **ActionBar in BottomNav mergen** (strukturell): Auf
   Rezept-Detail-Routes die BottomNav durch die ActionBar ersetzen
   (route-conditional render in `AppLayout`). Pro: keine Overlap-
   Frage mehr. Kontra: User verliert den Zugriff auf Start/Gruppen/
   Wochenplan-Nav auf dem Rezept-Screen — braucht Back-Arrow plus
   klare UX-Entscheidung.
3. **ActionBar non-fixed am Ende des Content** (klassisch): Statt
   `fixed bottom-` die Bar als letzten Block der Seite rendern, mit
   `sticky bottom-[calc(env(safe-area-inset-bottom)+56px)]` falls
   sinnvoll. Pro: keine dynamische Viewport-Mathematik. Kontra:
   Primary-Action ist nicht mehr auf Screen beim Scrollen durch
   lange Zutaten-Listen — der UX-Grund warum die Bar fixed ist
   fällt weg.
**Priority:** HIGH — primäre CTAs unklickbar auf Mobile ist
funktions-blockierend, gehört in die nächste Bug-Welle.
**Test-Strategie:** CSS/Layout-Bug → Component-Test + computed-style
assertion:
- `RecipeActionBar.test.tsx`: rendere in `jsdom` mit fake viewport
  375 × 667, assert dass `getComputedStyle(actionBar).zIndex` > dem
  der BottomNav (**Regressions-Gate gegen z-Index-Mismatch**).
- Integration: Playwright-E2E auf iPhone SE-Profile, scroll durch
  langes Rezept, assert dass sowohl "In Wochenplan" als auch
  "Jetzt gekocht" am Ende via `page.locator('button').isVisible()`
  klickbar sind und nicht von `nav[aria-label="Hauptnavigation"]`
  überlagert werden (`.boundingBox()` Overlap-Check).
- Grep-Guard: assert dass kein `z-\[[0-9]\]` unter 30 in
  `features/recipes/*ActionBar*` auftritt (verhindert Regression auf
  kleinen z-Wert).

---

## BUG-022 · Foto-Extraktion: erster Step landet zusätzlich in Beschreibung
**Reported:** 2026-04-20
**Status:** `[x] fixed` (2026-04-20 — `SYSTEM_PROMPT_DE` in beiden
Prompt-Dateien um eine `description`-als-Zusammenfassung-Direktive
ergänzt + `_normalise_description` Helper in `post_process.py`
dropt `description` wenn ≥ 80 % SequenceMatcher-Ähnlichkeit zu
`steps[0].content` (oder Substring-Match in beide Richtungen);
3 Unit-Tests in `test_pipeline_post_process.py` + grep-style Prompt-
Regression in `test_recipe_prompts.py` und `test_photo_prompts.py`.)
**Severity:** medium (UX — doppelter Text im Formular, User muss beim
Review manuell aufräumen; nicht blockierend aber nervt bei jedem
Handschrift-Import)
**Where:**
- `apps/python-extractor/src/extractor/prompts/photo_recipe.py:72-93` —
  `SYSTEM_PROMPT_DE` sagt zwar "Setze ursprüngliche Rezept-Überschriften
  als title" aber definiert nicht, was `description` enthalten soll
  vs. was nach `steps` gehört. Das URL-prompt in
  `prompts/recipe_extraction.py:130-150` hat das gleiche Problem, aber
  bei Video/Blog-Quellen trennt der LLM meist korrekt weil mehr Kontext
  vorliegt — bei isolierten Foto-Scans ohne Blog-Prosa greift der LLM
  öfter auf "first sentence = description, plus also first step".
- `apps/python-extractor/src/extractor/pipeline/post_process.py:90-123`
  — Post-Process hat **kein Dedupe** zwischen `description` und
  `steps[0]`, reicht die LLM-Ausgabe 1:1 durch.
**Symptom:** Bei Bild-Import erscheint der Text des ersten Schritts
wortgleich (oder stark ähnlich) auch im Beschreibung-Feld des
Formulars. Beispiel: wenn Schritt 1 = "Zwiebel fein hacken und in
heißer Butter glasig dünsten", steht in Beschreibung oft derselbe
Satz oder eine Paraphrase davon.
**Root cause (vermutet):** Azure Vision-LLM sieht bei handschriftlichen
Rezepten wenig Prosa-Kontext (nur Zutatenliste + Schritte). Um das
`description`-Feld (im Schema required als `["string", "null"]`) zu
füllen, greift es auf den ersten Step als "Beschreibung der
Zubereitung" zurück und emittiert ihn in BEIDEN Feldern. Kein
technischer Bug, sondern Prompt-Engineering-Lücke + fehlender
Dedupe-Guard.
**Likely fix — 3 Optionen, kombinierbar:**
1. **Prompt schärfen** (billig, erste Verteidigungslinie):
   `photo_recipe.py:SYSTEM_PROMPT_DE` ergänzen um einen expliziten
   Satz: *"Das Feld `description` ist NUR für eine knappe
   Zusammenfassung (max. 1–2 Sätze), was das Gericht ist — z.B.
   'Klassischer Rührteig mit Äpfeln'. Wiederhole dort KEINE Schritte,
   Zutaten oder Zubereitungsanweisungen. Wenn keine sinnvolle
   Zusammenfassung aus dem Foto ableitbar ist, setze `description`
   auf `null`."* Gleiches im URL-Prompt spiegeln (sauber halten).
2. **Post-Process-Dedupe** (defense-in-depth):
   `post_process.py` bekommt nach Step 118 einen Guard: wenn
   `description` ≥ 80 % Levenshtein-Ähnlichkeit (oder normalised-
   substring-match) mit `steps[0].text` hat, setze `description =
   None`. Schlank via `difflib.SequenceMatcher` aus stdlib — keine
   neue Dependency. Rettet auch URL-Extraktionen falls LLM dort mal
   dasselbe tut.
3. **Frontend-Review-Warnung** (Leichtgewicht): im `RecipeFormPage`
   Prefill-Review-Block einen Hinweis rendern wenn
   `description.trim() === steps[0]?.text.trim()` — "Tipp: Beschreibung
   und erster Schritt sind identisch — ggf. Beschreibung löschen."
   Pro: kein Pipeline-Change, User behält Kontrolle. Kontra: reiner
   UX-Polish, löst Root-Cause nicht.
**Priority:** medium — Prompt-Fix (#1) + Post-Process-Dedupe (#2)
zusammen sind der richtige Fix; #3 ist nice-to-have und kann wegfallen.
Bundle-Kandidat mit der nächsten LLM-Prompt-Polish-Runde.
**Test-Strategie:** Domain-Logic-Bug → Unit-Test im Python-Extractor
laut Regression-Test-Policy:
- `test_photo_prompts.py`: neuer Test assert dass
  `SYSTEM_PROMPT_DE` explizit "description" und "nicht wiederholen"
  in einem Satz erwähnt (grep-style, fängt Prompt-Regressions).
- `test_post_process.py`: Theory-Test mit 3 Inputs:
  (a) `description="Zwiebel hacken und dünsten"`, `steps[0]="Zwiebel
      hacken und dünsten"` → assert description == None nach
      post_process (exact match).
  (b) `description="Klassischer Apfelkuchen"`,
      `steps[0]="Zwiebel hacken"` → assert description unverändert
      (kein false-positive).
  (c) `description="Zwiebel fein hacken"`, `steps[0]="Zwiebel hacken
      und in Butter dünsten"` → Borderline — Entscheidung beim
      Impl-Zeitpunkt, mit Threshold dokumentieren.
- Integration-Test mit einer echten kleinen Foto-Fixture (falls
  vorhanden) — opportunistisch, kein Gate.

---

## BUG-023 · Gap unter BottomNav wenn Browser-Chrome beim Scrollen einzieht
**Reported:** 2026-04-20
**Status:** `[x] fixed` (2026-04-20 — Option 1 aus dem Backlog umgesetzt: neue CSS-Custom-Property `--viewport-bottom-offset` (Default `0px` in `index.css` neben `--bottom-nav-height`), die von einem RAF-throttled `window.visualViewport`-Listener im `AppLayout`-`useEffect` gepflegt wird (`offset = max(0, innerHeight - vv.height)`). Feature-Detection: ohne `window.visualViewport` (Pre-iOS-13) bleibt der Wert `0px`. Drei Consumer applizieren den Offset im `bottom-[calc(... + var(--viewport-bottom-offset,0px))]`-Tail: `BottomNav` (mobile inset), `RecipeActionBar` (sticky bar, mobile + md+) und der Inline-Notifier auf demselben Element. Tests: `AppLayout.test.tsx` mit visualViewport-Stub (innerHeight=700, vv.height=600 → Offset 100px nach `resize`-fire + RAF-flush via `act`); Token-Guard in derselben Datei für `--viewport-bottom-offset` in `index.css`; Grep-Gates in `BottomNav.test.tsx` (1× var-Match) und `RecipeActionBar.test.tsx` (≥2× var-Match für Bar + Notifier). 1075 Web-Tests grün, Lint clean, Build ok.)
**Severity:** medium (visual — BottomNav bleibt klickbar, man sieht nur
durch die Lücke den darunter liegenden Seiten-Content; stört aber
merklich auf Mobile und macht die App weniger "nativ"-wirkend)
**Where:** `apps/web/src/components/layout/BottomNav.tsx:50-62`
(positioning) + indirekt `apps/web/src/index.css` Viewport-Setup.
**Symptom:** iOS Safari und Chrome-Mobile blenden die untere Browser-
Toolbar (Zurück / Vorwärts / Tabs) beim Scrollen nach unten aus. Unsere
BottomNav hängt an `bottom-[env(safe-area-inset-bottom,0px)]`, bewegt
sich aber **nicht** mit der animierten Toolbar-Retraktion mit. Ergebnis:
eine ~50 px hohe Lücke zwischen BottomNav und dem neuen visuellen
Viewport-Rand wird sichtbar — man schaut durch die Transparenz der
BottomNav-Glasmorphose auf den Page-Content dahinter.
**Root cause:** Klassisches Layout-Viewport vs. Visual-Viewport-Problem:
- `env(safe-area-inset-bottom)` reagiert nicht auf dynamische Chrome-
  Animation; nur auf Home-Indicator-Area. Wenn Chrome sich zurückzieht,
  bleibt der Wert konstant.
- `position: fixed` referenziert den **Layout-Viewport**, nicht den
  animiert-schrumpfenden Visual-Viewport. Während der Retract-Animation
  driftet die Bar relativ zum Visual-Bottom nach oben weg.
- Chrome-Safari berechnet `100dvh` dynamisch neu — aber `fixed
  bottom-[…]` erbt das nicht automatisch, weil Safari's dynamische
  Toolbar-Animation aus Performance-Gründen nur die Bildschirm-
  Projektion ändert, nicht das Layout.
**Likely fix — 3 Optionen mit Trade-offs:**
1. **`visualViewport`-API + CSS-Variable** (empfohlen, modern):
   Einmalig im App-Layout-Effekt einen Listener auf
   `window.visualViewport` registrieren; bei jedem `resize`/`scroll`-
   Event wird eine CSS-Custom-Property gesetzt:
   ```ts
   const vv = window.visualViewport
   const update = () => {
     const offset = window.innerHeight - (vv?.height ?? window.innerHeight)
     document.documentElement.style.setProperty(
       '--viewport-bottom-offset', `${offset}px`
     )
   }
   vv?.addEventListener('resize', update)
   vv?.addEventListener('scroll', update)
   ```
   Dann BottomNav:
   `bottom-[calc(env(safe-area-inset-bottom,0px)+var(--viewport-bottom-offset,0px))]`.
   Bar folgt dem Visual-Viewport 1:1.
   Pro: sauber, standards-konform (VisualViewport ist W3C baseline);
   löst auch Keyboard-Overlay-Gap beim Chat-Input. Kontra: zusätzlicher
   Listener, muss 60 fps glatt laufen (RAF-throttling einbauen).
2. **`100dvh`-basierter Layout-Trick:** BottomNav nicht fixed, sondern
   letzter Block einer `min-h-dvh flex-col` Layout-Schiene, die mit
   `flex-grow` + `overflow-auto` den Page-Content scrollt. Die Bar sitzt
   "physikalisch" am Flex-Ende, nicht per `fixed`. Pro: keine
   JS-Listener, browser-native. Kontra: grosser Umbau von
   `AppLayout.tsx:50`; muss mit SignalR-Push-Toasts + RecipeActionBar-
   Overlay kompatibel bleiben.
3. **Acceptance** (0-Aufwand-Option): Status-quo belassen, aber
   BottomNav-Hintergrund auf `bg-background` statt `bg-background/82`
   setzen + `backdrop-blur` weg. Pro: der Gap ist nicht mehr sichtbar
   weil solide Farbe. Kontra: visueller Glasmorphose-Effekt
   verschwindet; der Gap existiert noch, wird nur kaschiert — Android-
   Nutzer sehen ihn teilweise trotzdem weil dort die Toolbar oben
   retracted, aber unten eine Tab-Preview auftauchen kann.
**Priority:** medium — passt zusammen mit BUG-021 in eine
Mobile-Chrome-Polish-Welle. Option 1 ist der einzige echte Fix.
**Test-Strategie:** Frontend-UX-Bug → Integration-Test + Component-Test:
- `AppLayout.test.tsx`: mock `window.visualViewport` mit `height=600`
  und fire `resize` auf `700` → assert dass
  `document.documentElement.style.getPropertyValue(
  '--viewport-bottom-offset')` === `"100px"`.
- `BottomNav.test.tsx`: grep-style assert dass classes das
  `var(--viewport-bottom-offset)` referenzieren (Regressions-Gate
  gegen versehentlichem Entfernen des calc()).
- Manuelle Playwright-Probe auf iPhone-SE-Profile mit
  `emulateMedia({media:'screen'})` + `page.evaluate` um
  visualViewport zu shrinken; assert BottomNav boundingBox.bottom ≤
  visualViewport.height.
- Als Bonus: ChatPage `h-[calc(100dvh-…)` kann dieselbe CSS-Variable
  re-usen → cleaner one-source-of-truth (BUG-001-Follow-up, weil der
  Gap dort schon einmal als Root-Cause auftauchte, BUG-001-Fix hat
  das Problem nur für den Chat-Input addressiert, nicht global).

---

## BUG-024 · Foto-Import: Staged-Fotos sind im Formular unsichtbar, erscheinen erst nach Speichern
**Reported:** 2026-04-20
**Status:** `[x] fixed` (2026-04-20 — Option 1 aus dem Backlog umgesetzt: neues `PhotoUploadGrid`-Prop `preAttached: { stagedPhotoId, url, isThumbnail? }[]` rendert server-seitig gestagte Fotos als Thumbnails im Create-Mode-Grid (vor den `File[]`-Slots, `Import`-/`Thumbnail`-Pill oben-links, `×`-Remove oben-rechts, 3-Foto-Cap gilt jetzt gemeinsam für `preAttached` + `files`). `importGroupMemo.ts` persistiert neben der Id jetzt auch die signed SeaweedFS URL (`rememberImportStagedPhotos`/`recallImportStagedPhotos`); Legacy-`string[]`-Sessions werden weiterhin gelesen (URL fällt auf `""`). `ImportPhotosPage` füttert die `{id,url}`-Pairs aus `uploadStagedPhoto` in den Memo. `RecipeFormPage` liest die Liste, filtert URL-lose Einträge raus (BUG-018-Video-Thumbnail hat serverseitig noch keine exposed URL → bleibt badge-only-Fallback) und rendert den Rest via `PhotoUploadGrid.preAttached`. Entfernen-Button feuert neuen Backend-Endpoint `DELETE /api/staged-photos/:id` (Ownership-Check, 404 für unknown / bereits-promoted, 403 bei fremdem Uploader, 204 happy path; Blob-Delete best-effort). Amber-Pill umformuliert zu "Diese Fotos werden beim Speichern angehängt" (ohne Count, weil User die Fotos jetzt sieht). Regression-Tests: `PhotoUploadGrid.test.tsx` +5 Tests (img-Render, Badge-Text, Remove-Callback, Cap bei 3, kein Remove-Button ohne Handler); `RecipeFormPage.test.tsx` +2 Integration-Tests (preAttached-Thumbnails + Pill; DELETE + Memo-Update on remove); `importGroupMemo.test.ts` +8 Round-Trip-Tests für das neue `{id,url}`-Schema + Legacy-String-Array-Backward-Compat. Backend: +4 Integration-Tests in `RecipeEndpointsTests.cs` (happy path, 401 anon, 403 fremder User, 404 unknown id). 1071 Web-Tests grün, 715 API-Tests grün, Lint clean, Build ok.)
**Severity:** medium — UX-Erwartungs-Mismatch: User verunsichert ob
die hochgeladenen Fotos wirklich ans neue Rezept kommen, hochlädt ggf.
nochmal. Nicht funktions-brechend (Save-Pfad funktioniert), aber
Trust-erodierend.
**Where:** `apps/web/src/features/recipes/RecipeFormPage.tsx:729-756`
(create-mode render-branch) + `PhotoUploadGrid.tsx` (kennt nur zwei
Modi: `existing photos` + `File[] für neue uploads`, kein Modus für
"bereits-server-seitig-gestagte Fotos mit Signed-URL").
**Symptom:** Nach Foto-Import (1–10 Fotos) öffnet sich das Rezept-
Formular im Review-Modus. Der User sieht:
- eine kleine Amber-Pill oben rechts im Foto-Card: *"3 Fotos werden
  beim Speichern angehängt."* (leicht zu übersehen)
- darunter ein leeres `PhotoUploadGrid` mit `+ Foto hinzufügen` Slots
- **keine Thumbnails** der tatsächlich importierten Fotos.
Erst nach Save → Navigation zum Recipe-Detail → sieht er die drei
Fotos am Rezept.
**Root cause:** `stagedPhotoIds: string[]` wird im Wrapper korrekt
eingesammelt (inkl. BUG-018-Thumbnail), aber nur als **Zähler** im
Badge + im POST-Body an den Promote-Endpoint weitergegeben. Die
`PhotoUploadGrid`-Komponente hat aktuell keinen Pfad, um StagedPhotos
per `stagedPhotoId` + Signed-URL nachzuladen und als visuelle Kacheln
zu rendern. Grund: das File-Binary liegt schon in SeaweedFS, der
Browser hat aber keinen `File`-Blob dafür mehr.
**Likely fix — 3 Optionen:**
1. **Neuer `PhotoUploadGrid`-Modus "staged-server"** (empfohlen,
   sauberster Weg):
   - Neues Prop: `preAttached?: { stagedPhotoId: string; url: string;
     isThumbnail?: boolean }[]`.
   - `ImportPhotosPage` persistiert nicht nur die IDs in
     `importGroupMemo` sondern **auch die Preview-URLs**, die der
     staged-photo-upload sowieso zurückgibt (`StagedPhotoResponse.url`
     — das ist die signed SeaweedFS URL). `RecipeFormPage`-Wrapper
     liest beide, reicht sie als `preAttached` runter.
   - `PhotoUploadGrid` rendert die `preAttached`-Kacheln VOR den
     neuen Upload-Slots, mit einem kleinen Hint-Badge ("importiert")
     und — optional — einem Entfernen-Button (ruft
     `DELETE /api/staged-photos/:id` auf, zieht aus der Liste, so
     kann User unerwünschte Import-Fotos abwählen bevor er speichert).
   - BUG-018-Thumbnail (Video) taucht im selben Grid auf, mit Badge
     "Thumbnail", gleicher Remove-Flow.
   Pro: volle visuelle Bestätigung, Parity zu "edit-mode photos";
   scaled bereits BUG-018 mit ab.
   Kontra: braucht kleinen Backend-Check ob
   `DELETE /api/staged-photos/:id` bereits existiert (sonst Endpoint
   nachziehen + RecipeImport-Unverknüpfen sauber machen).
2. **Preview-URLs im `stagedPhotoIds`-Memo mitspeichern** ohne neues
   Grid-Feature: Badge erweitern auf inline-Grid aus 3 Mini-
   Thumbnails (64 × 64 px) per `<img>`-Tag. Pro: kein
   `PhotoUploadGrid`-Refactor. Kontra: zwei Grid-Strukturen
   nebeneinander, kein einheitliches "hier sind deine Fotos"-Gefühl;
   Remove-Funktion wird komisch zu verorten.
3. **Banner-Copy anpassen** (0-Aufwand, rein UX):
   Pill umformulieren zu einer auffälligeren Info-Box mit Icon-Stack
   ähnlich wie der Import-Provenance-Banner, statt inline-Pill. Der
   User ignoriert die Info nicht mehr, sieht die Fotos aber trotzdem
   nicht. Kontra: palliativ statt fix; Vertrauen bleibt geschwächt
   weil User "sehen will".
**Priority:** medium — Option 1 lohnt, weil es auch das BUG-018-
Thumbnail-Onboarding visualisiert (aktuell weiß der User beim
Video-Import auch nicht dass ein Thumbnail staged ist — der sieht
auch nur die Badge-Zahl). Zwei UX-Fragen werden in einem
Grid-Refactor abgeräumt.
**Test-Strategie:** Frontend-UX-Bug → Component-Test mit State-Setup
laut Regression-Test-Policy:
- `PhotoUploadGrid.test.tsx`: neue Tests mit `mode="create"` +
  `preAttached=[{id,url}]` Prop → assert dass pro preAttached-Eintrag
  ein `<img src>` mit der URL rendert + Badge "Importiert" sichtbar ist.
- `RecipeFormPage.test.tsx`: integration — photo-import flow mit
  seedCache für `stagedPhotoIds + urls` → assert dass Grid
  `queryAllByRole('img')` ≥ `stagedPhotoIds.length` liefert.
- `importGroupMemo.test.ts`: Test dass URL-Payload neben IDs
  persistiert wird + `recallImportStagedPhotoUrls` in gleicher
  Reihenfolge zurückliefert.
- Optional: Integration-Test "staged photo remove" → `DELETE`
  `/api/staged-photos/:id` wird gerufen, preAttached-Item
  verschwindet, save fährt mit reduziertem `stagedPhotoIds`-Array
  weiter.

---

## BUG-025 · iOS Safari zoomt beim Fokus auf Input-Felder rein (Desktop-Look-Effekt)
**Reported:** 2026-04-20
**Status:** `[x] fixed` (2026-04-20 — Option 1 aus dem Backlog angewendet: alle `<input>`, `<textarea>`, `<select>`-Elemente mit `text-[14px]` / `text-[15px]` auf `text-base` (= 16 px) angehoben. Betroffen: `ChatPage.tsx` (Chat-Textarea), `ImportUrlPage.tsx` (URL-Input), `GroupFilterBar.tsx` (Such-Input), `RatingWidget.tsx` (Kommentar-Textarea), `RecipeFormPage.tsx` (FormInput/FormTextarea/FormSelect-Primitives + ingredient-row Überschreibungen für Menge/Einheit/Name/Notiz + Step-Textarea + Step-Preview-Div). Viewport-Meta bleibt a11y-konform (kein `maximum-scale=1`-Hack). Grep-Gate-Test `src/test/tokens/input-font-size.test.ts` scannt den ganzen `apps/web/src`-Tree und asserted, dass kein Form-Input-Tag einen `text-[(10–15)px]`-Token enthält — Regression-Gate gegen jede Neuanlage unter 16 px. Plus Smoke-Tests in `ChatPage.test.tsx`, `ImportUrlPage.test.tsx`, `RecipeFormPage.test.tsx` die asserten dass das jeweilige Haupt-Input-Element `text-base` in der className hat. Alle 1057 Tests grün, Lint clean, Build ok.)
**Severity:** medium — macht die App auf iPhone wie eine "Desktop-Seite
auf Mobile" wirken, nicht wie eine native-artige PWA. Jeder Input-Fokus
= Zoom-Pumpe, User muss rauszoomen/zurückscrollen. Nicht funktions-
brechend, aber stark Wahrnehmungs-schädigend.
**Where:** Betroffen sind alle Inputs/Textareas mit `font-size < 16px`.
Konkret (grep-verifiziert):
- `apps/web/src/features/chat/ChatPage.tsx:408` — Chat-Textarea
  `text-[15px]` (das User-Report-Symptom).
- `apps/web/src/features/imports/ImportUrlPage.tsx:251` — URL-Import
  Input `text-[15px]`.
- `apps/web/src/features/recipes/RecipeFormPage.tsx:1080, 1101, 1117,
  1452` — Form-Inputs / Textareas / Selects `text-[14px]` bzw.
  `text-[15px]` (Zutaten-Notes, Description, unit-Select, Tag-Input).
- `apps/web/index.html:14` — Viewport-Meta hat absichtlich kein
  `maximum-scale=1, user-scalable=no` (a11y-konform — Zoom bleibt
  erlaubt, ist der richtige Weg).
**Symptom:** User tippt auf Chat-Input (oder jedes andere Formular-
Feld) → iOS Safari / Chrome-Mobile zoomt auf ~150 % rein, das ganze
Layout springt. Nur wieder rauszoomen indem man ausserhalb tippt oder
pinch-zoom zurück.
**Root cause:** **iOS Safari auto-zoomt jedes Input-Element mit
`font-size < 16px` beim Fokus**, um sicherzustellen dass der Text für
den User lesbar ist. Das ist dokumentiertes WebKit-Verhalten (seit
iOS 3.0) und betrifft `input`, `textarea`, `select`. Chrome-Mobile
zieht mittlerweile nach. Unsere Design-Tokens haben Inputs auf 14–15 px
Schriftgröße gesetzt (aus Design-Consistency), was dicht unter der
iOS-Schwelle liegt.
**Likely fix — 3 Optionen, in Reihenfolge der Präferenz:**
1. **Inputs auf 16 px+ bringen** (empfohlen, a11y-konform + native-
   feel): alle `<input>`, `<textarea>`, `<select>`-Klassen von
   `text-[14px]` / `text-[15px]` auf `text-base` (= 16 px) bzw.
   `text-[16px]` anheben. Visuelles Tuning bei Bedarf via
   `tracking-tight` oder leicht dickerem padding, um die Höhe
   konsistent zu halten. Pro: kein JS, keine meta-tag-Hack, plus
   bessere Lesbarkeit (WCAG 1.4.4). Kontra: Design-Tokens müssen
   minimal angepasst werden (ein ganzes Pass über Form-CSS — geschätzt
   ~10–15 class-strings).
2. **Responsive font-size** (Kompromiss): `text-[15px] md:text-[14px]`
   oder via CSS-Media-Query `@media (max-width: 767px)` alle
   input/textarea-Selektoren auf `font-size: 16px`. Pro: Desktop
   behält kompaktere Felder. Kontra: zwei Quellen der Wahrheit,
   Tokens weichen vom Look-and-Feel-Prinzip "Mobile First".
3. **Meta-viewport-Hack** (NICHT empfohlen):
   `maximum-scale=1, user-scalable=no` in `index.html`. Pro: ein-Zeilen-
   Fix. Kontra: **bricht a11y** — User kann nicht mehr pinch-zoomen.
   iOS ignoriert das mittlerweile eh bei VoiceOver-aktiv, aber
   Android honoriert es und blockt Zoom hart. WCAG 1.4.4 verletzt.
   Nur als absolute Notlösung falls Design-Änderung unmöglich ist.
**Priority:** medium — gut als Teil einer gezielten Mobile-Polish-Welle
zusammen mit BUG-021 (ActionBar-Overlap) und BUG-023 (Viewport-Gap).
Option 1 ist klar gewinn.
**Test-Strategie:** CSS/Layout-Bug → grep-style + Component-Test
laut Regression-Test-Policy:
- **Grep-Gate** im Test-Suite: eine neue `test/tokens/input-font-size.test.ts`
  die mit fs.readFile + regex über `apps/web/src/**/*.tsx` läuft und
  assertiert, dass kein `<input`/`<textarea`/`<select` mit einer
  class-string gerendert wird, die `text-\[(1[0-5])px\]` enthält.
  Regressions-Gate gegen jede Neuanlage unter 16 px.
- **Component-Test** für `ChatPage`, `ImportUrlPage`, `RecipeFormPage`:
  render in jsdom, query das `<textarea>` / `<input>`, assert
  `getComputedStyle(input).fontSize >= "16px"`.
- **Playwright iPhone-SE-Profile**: focus input, assert
  `window.visualViewport.scale === 1` bleibt (kein Zoom getriggert).
  Opportunistisch, kein Gate (Playwright simuliert iOS-Safari-Zoom
  nicht 100 %-ig akkurat).

---

## BUG-026 · Chat-Antwort erscheint leer + zweite Nachricht wirft "Inhalt darf nicht leer" (zwei Symptome, ein Root-Cause)
**Reported:** 2026-04-20 (zwei separate User-Reports, gleiche Wurzel)
**Status:** `[x] fixed` (2026-04-20 — Option 1 aus dem Backlog angewendet: `chatApi.sendChatTurn` holt jetzt das Python-Wire als `ChatTurnResponseWire { assistant_message: string }` und normalisiert am Edge auf `{ assistantMessage }` — analog zum bestehenden Muster aus `importsApi.mapStatusResponse`. .NET-Proxy + Python bleiben unverändert. Drei Regression-Tests abgedeckt: `chatApi.test.ts` asserts snake→camel Roundtrip und enthält ein Grep-Regression-Gate dass der Wire-Type-Name `assistant_message` im Source bleibt; `ChatPage.test.tsx` fährt beide Symptome in einem Integrations-Flow durch — erster Turn rendert Bubble "Ja gerne", zweiter Turn-Body trägt eine wohlgeformte History ohne `content === undefined` oder fehlenden `content`-Key. Alle 47 Chat-Tests grün, Lint clean, Build ok.)
**Severity:** HIGH — Chat-Feature funktioniert faktisch gar nicht auf
prod. 1. Turn zeigt leeres Assistant-Bubble, 2. Send crasht mit
server-side 400.
**Where:**
- **Wire-Ursprung:** `apps/python-extractor/src/extractor/main.py:269-278`
  — `ChatResponse` returned JSON `{"assistant_message": "..."}` in
  **snake_case** (FastAPI + pydantic default, keine alias_generator).
- **Proxy:** `apps/api/src/FamilienKochbuch.Api/Endpoints/ChatEndpoints.cs:289-295`
  — .NET reicht das Python-Body **verbatim** durch (`Results.Content(
  bodyText, contentType, …)`), **keine snake→camel Konversion**.
- **Frontend:** `packages/shared/src/types/chat.ts:34-36` +
  `apps/web/src/features/chat/chatApi.ts:57-65` — TS-Type erwartet
  `assistantMessage` (camelCase). `request<ChatTurnResponse>` castet
  blind ohne Normalisierung.
- **Downstream-Trigger für Symptom #2:**
  `apps/web/src/features/chat/ChatPage.tsx:213-216` —
  `setMessages((prev) => [...prev, { role: 'assistant', content:
  res.assistantMessage }])` pusht `content: undefined` ins Array.
  Beim nächsten Send wird die komplette History erneut gesendet;
  `ChatEndpoints.cs:325-330` validiert `string.IsNullOrWhiteSpace(
  m.Content)` → 400 `invalid_message` → User sieht "Nachrichten-
  inhalt darf nicht leer sein."
**Symptom #1 (user report 1):** Nach "Senden" im Chat erscheint ein
leeres Assistant-Bubble unterhalb der User-Nachricht. Text nicht
sichtbar, kein Error-Banner.
**Symptom #2 (user report 2):** Zweite User-Nachricht im gleichen
Session-Turn wird mit Error abgelehnt: "Nachrichteninhalt darf nicht
leer sein." — obwohl im Input-Feld klar Text steht.
**Root cause (gemeinsam):** snake_case/camelCase-Wire-Mismatch zwischen
Python und Frontend; .NET-Proxy macht keinen Case-Convert. Das
Assistant-Bubble zeigt nichts (undefined → React rendert nichts),
die History enthält aber einen Eintrag mit `content: undefined` →
bei Serialisierung wird das zu `{"role":"assistant"}` ohne
`content`-Key, was das Backend als leer wertet.
**Likely fix — 3 Optionen (erste empfohlen):**
1. **Frontend-Mapper in `chatApi.ts`** (minimal-invasiv,
   Mustern wie `importsApi.mapStatusResponse` folgend):
   ```ts
   interface ChatTurnResponseWire { assistant_message: string }
   export async function sendChatTurn(body: ChatTurnRequest):
     Promise<ChatTurnResponse> {
     const wire = await request<ChatTurnResponseWire>('/api/chat', …)
     return { assistantMessage: wire.assistant_message }
   }
   ```
   Pro: einzige-Stelle-Fix, konsistent mit dem bestehenden
   snake→camel-Muster aus dem Imports-Flow; kein Backend-Deploy
   nötig. Kontra: wenn zusätzliche Chat-Endpoints kommen (to-recipe
   ist schon ExtractionResult-shaped, da greift ein anderer
   Mapper-Pfad), muss pro Endpoint sauber weitergepflegt werden.
2. **.NET-Proxy konvertiert** (alternativ):
   `ChatEndpoints.ChatTurnAsync` deserialisiert den Python-Body zu
   einem server-side DTO und serialisiert mit
   `JsonSerializerDefaults.Web` (camelCase) weiter. Pro: Wire wird
   zentral sauber, alle Clients bekommen camelCase. Kontra: macht
   den "pure proxy"-Ansatz des Plan-Kontrakts kaputt; hebt auch die
   Extractor-Header-Weiterreichung nicht auf, muss aber jeden Feld-
   Namen kennen (aktuell passes der Proxy auch zukünftige Felder
   ungesehen durch).
3. **Python emittiert bereits camelCase** (globale Lösung):
   `ChatResponse.model_config` bekommt
   `alias_generator=to_camel, populate_by_name=True`, FastAPI
   `response_model_by_alias=True` als Endpoint-Option. Pro: Source-
   of-truth-Fix, alle Endpoints gewinnen mit. Kontra: breiter Blast-
   Radius — andere Python-Responses (ExtractionResult, Health,
   Progress-Callback) sind alle snake_case konvention-ierend; ein
   unbedachter Schwung auf camelCase bricht potenziell
   `importsApi.mapStatusResponse` und den JSON-Strict-Match auf
   `ResultJson`. Nur mit kompletter Proxy-Impact-Analyse.
**Priority:** HIGH — Chat ist ein Feature-komplett-Ausfall. Prompt
fixen, am besten mit Option 1 als hotfix in next-bug-sweep. Ein Regel-
Ticket "wire-normalisation audit" könnte die Parallelen in anderen
Endpoints (`/api/chat/{sessionId}/to-recipe` → ExtractionResult;
`/api/chat/:id/usage` falls existiert) prüfen.
**Test-Strategie:** Backend-Endpoint-Bug + Frontend-UX-Bug, zwei-
schichtig:
- `chatApi.test.ts`: vitest + msw mock `POST /api/chat` that returns
  `{ assistant_message: "Hallo" }` → assert
  `sendChatTurn(…)`-Rückgabe hat `{ assistantMessage: "Hallo" }`.
- `ChatPage.test.tsx`: Integration — user typt 1. msg, mocked response
  returns `{ assistant_message: "Ja gerne" }`, assert dass Assistant-
  Bubble "Ja gerne" rendert. Dann 2. User-Nachricht senden → assert
  POST-Body enthält `[{role:"user",content:"Hi"},{role:"assistant",
  content:"Ja gerne"},{role:"user",content:"..."}]` mit **keinem**
  undefined-content-Eintrag.
- `ChatEndpointsTests.cs`: Integration-Test verifiziert dass bei
  wohlgeformter Python-response (snake_case mit `assistant_message`)
  der Proxy den camelCase nicht ändert aber die Validierung
  downstream trotzdem durchgeht. (Falls Fix-Option 1 gewählt — dieser
  Test bleibt genau so grün; falls Option 2 gewählt → Test-Assertion
  auf camelCase-Body-Roundtrip.)
- **Regression-Grep-Gate:** Test dass in `chatApi.ts` der Wire-Type
  `assistant_message` explizit deklariert ist (verhindert spätere
  Regression durch "type assertion nur" ohne Mapper).

---

## BUG-027 · Video-Import: Progress bleibt minutenlang bei 5%, dann plötzlich 100%
**Reported:** 2026-04-20 (während Bug-Sweep-2)
**Status:** `[x] fixed` (2026-04-20 — Optionen 1 + 2 umgesetzt: `_make_ytdlp_progress_wrapper` priorisiert jetzt `fragment_index/fragment_count` (HLS) als authoritative Progress-Quelle, fällt sonst auf `total_bytes` / `total_bytes_estimate` zurück und nutzt bei wirklich unbekanntem Total eine elapsed-time-Ramp `min(95, int(elapsed * 3))` mit Cap bei 95 % damit die Phase nie automatisch komplettiert. Zusätzlich neuer `ProgressReporter.start_heartbeat`/`stop_heartbeat`-API mit 2 s-Loop der den letzten `phase_progress` mit `force=True` re-emittiert — wird in `pipeline/url.py` für `downloading`, `transcribing` und `structuring` aufgesetzt, in einem `try/finally` immer gestoppt, und tolerant gegenüber Mehrfach-Start/Stop. 17 neue Python-Tests (10 Wrapper-Heuristiken + 7 Heartbeat) plus `smoke-live.sh` jetzt mit ≥ 3-distinct-progress-Assertion in den ersten 30 s. Option 3 (Frontend trust-chain Phantom) bewusst nicht umgesetzt — Security-Gate bleibt unverändert.)
**Severity:** HIGH — PV1-PV4 ganzer Slice war darauf designed die
0→5→100-Sprungstufe zu eliminieren. Aktuell tut der Slice in prod das
nicht, weil Facebook-/Instagram-Downloads fragmentiert sind und
yt-dlp für diese Quellen `total_bytes=0` liefert.
**Where:**
- `apps/python-extractor/src/extractor/pipeline/url.py:574-588` —
  `_safe_percent(done, total)` returnt **0** sobald `total <= 0`. Mit
  einem FB-m3u8-Stream bleibt `total_bytes=0` den gesamten Download
  lang → `phase_progress=0` → kein erkennbarer Fortschritt.
- `apps/python-extractor/src/extractor/pipeline/video.py:317-349` —
  `_make_ytdlp_progress_wrapper` forwarded nur `downloaded_bytes` +
  `total_bytes` (oder `total_bytes_estimate` als Fallback). FB liefert
  häufig keinen davon zuverlässig.
- `apps/python-extractor/src/extractor/progress.py:44` — `_THROTTLE_MS
  = 500`. Events mit `phase_progress=0` gelten als "keine Änderung"
  → werden bei wiederholtem gleichen Wert gefiltert.
- `apps/web/src/features/live/useLiveSync.ts:160-170` — **sekundärer
  Verschärfungsfaktor**: `applyImportProgressEvent` returnt silently
  wenn kein `prev` (REST-GET noch nicht gelandet). Der ERSTE SignalR-
  Event bei Import-Enqueue-plus-Navigate fällt ggf. immer weg.
**Symptom:** User sieht beim Video-Import Phase "downloading" +
"5 %" für 15–90 s (je nach Video-Länge). Dann plötzlich Sprung auf
Transcribing oder direkt 100 %. Das PV4-Design-Ziel "progress feels
alive" ist damit verfehlt.
**Root cause (klar identifiziert):** FB + IG + TikTok-URLs resolven
bei yt-dlp häufig zu m3u8-Fragment-Streams. `total_bytes` ist bei
Fragmenten meist `None`/`0`, weil die Gesamtgröße erst nach
Verkettung bekannt ist. `total_bytes_estimate` hilft nur manchmal.
Ohne `total` ist `_safe_percent = 0`, was bedeutet die Download-
Phase macht UI-seitig **null** sichtbare Fortschrittsangabe.
**Likely fix — mehrschichtig, idealerweise alle 3:**
1. **Python: phase_progress-Heuristik bei unbekanntem total**
   (wichtigster Fix). `_make_ytdlp_progress_wrapper` nimmt optional
   einen elapsed-time-Start-Timestamp auf; wenn `total==0`, berechnet
   sich `phase_progress = min(95, int(elapsed_seconds * 3))` —
   rampt linear in ~30 s auf 90 %, Cap bei 95 %, transitioniert dann
   zur nächsten Phase. Zusatz: wenn yt-dlp `fragment_index` +
   `fragment_count` mitliefert (häufig bei HLS), diese Werte
   verwenden → `phase_progress = int(fragment_index / fragment_count
   * 100)`. Echte relative Position wenn verfügbar, sonst elapsed-
   time-Ramp.
2. **Python: heartbeat-event alle 2 s während downloading +
   transcribing + structuring**. asyncio-timer im `ProgressReporter`
   emittiert force=True Event (umgeht Throttle) mit aktuellem Phase-
   State. Frontend `StaleBanner` reagiert ab 30 s idle — Heartbeat
   verhindert dass er aktiviert wird und signalisiert "alive".
3. **Frontend: Skip-if-no-prev opportunistisch lockern** (SECURITY-
   SENSIBEL!). Aktuell wird ein SignalR-Event verworfen wenn
   REST-GET noch nicht gelandet ist. Security-Grund: Phantom-DTO für
   fremde importId könnte Cache kompromittieren. ALTERNATIVE:
   Phantom erlauben wenn URL-pathname `/rezepte/import/:id` mit
   `id === payload.importId` matcht UND `importGroupMemo` für die
   importId dasselbe `groupId` wie `payload.groupId` liefert →
   trust-chain verifiziert. Dokumentieren als "opportunistic phantom
   only on own-import own-group trust-chain".
**Priority:** HIGH — Kernfeature-Demonstration nicht stabil. Option 1
ist Must-have, Option 2 nice-to-have im selben Slice, Option 3
separater kleiner Follow-up.
**Test-Strategie:** Domain-Logic-Bug → Unit + Integration:
- `test_pipeline_video.py`: neuer Test — mock yt-dlp-hook mit
  3 Events (total_bytes=0, downloaded_bytes=steigend) über 2 s →
  assert phase_progress steigt monoton von 0 auf > 0 dank
  elapsed-time-Heuristik.
- `test_pipeline_video.py`: mock info mit
  `status="downloading", fragment_index=5, fragment_count=20` →
  expect phase_progress ≈ 25.
- `test_progress.py`: Heartbeat-Test, asyncio fake-clock 5 s laufen
  lassen → assert ≥ 2 heartbeat-Events emittiert.
- `useLiveSync.test.tsx`: falls Option 3 umgesetzt, trust-chain-
  phantom-allow (match) + cross-group-phantom-reject.
- Ops/Live-Smoke: `smoke-live.sh --import-url=<fb-url>` Assertion:
  mindestens 5 **distinct phase_progress-Werte** innerhalb der
  ersten 30 s (nicht nur 5 distinct phases).

---

## BUG-028 · Video-Import: Zutaten-Mengen durcheinander (2g in quantity, ~900g in description)
**Reported:** 2026-04-20 (während Bug-Sweep-2, URL:
`facebook.com/share/r/18gMgiLGLB/?mibextid=wwXIfr`)
**Status:** `[x] fixed` (2026-04-20 — `SYSTEM_PROMPT_DE` in beiden
Prompt-Dateien um die "Zahl+Einheit gehört IMMER in quantity+unit,
NIEMALS in description/note"-Direktive + Portionszahl-Klärung
ergänzt; `_flag_mass_leak_in_description` Helper in `post_process.py`
downgraded Confidence shaky-quantity-Zutaten auf `"low"` wenn
`description` ein Mass-Pattern `\d+\s*(g|kg|ml|l|EL|TL|Stück|Prise)`
enthält (Variante a, kein Auto-Attach); 3 Unit-Tests inkl. Cross-Bug-
Skip-Test (description war BUG-022-deduped → kein Downgrade).)
**Severity:** medium (Datenqualität — Rezept nach Import enthält
nachweislich falsche Mengen, User muss manuell pflegen)
**Where:**
- `apps/python-extractor/src/extractor/prompts/recipe_extraction.py:130-170`
  — `SYSTEM_PROMPT_DE` definiert nicht hart, dass Mengen-Strings wie
  "900 g" komplett im `quantity`-Feld landen sollen statt in
  `description` oder `note`.
- `apps/python-extractor/src/extractor/pipeline/post_process.py` —
  kein Validator der `\d+\s*(g|ml|kg|l)` in `description` catcht.
- `apps/python-extractor/src/extractor/pipeline/url.py` — Whisper-
  Transkript geht 1:1 an Azure. Bei verrauschter FB-Reel-Audio kann
  Whisper Mengenangaben falsch hören ("zweihundert Gramm" → "2
  hundert g") → Azure pickt die erste Zahl als `quantity`.
**Symptom:** Nach Video-Import: Zutat z.B. `quantity="2", unit="g"`
obwohl der tatsächliche Wert ~900 g war. Die ~900 g erscheinen
freitext-artig in `description` oder `note`. Bei Portionsangaben
("2 Personen, 900 g Fleisch") unklar ob Azure die Personenzahl als
Menge interpretiert.
**Root cause (vermutet, nicht live-reproduziert):** Zwei Faktoren:
1. **Whisper-Quality**: FB-Reels mit leiser/verrauschter Audio +
   Hintergrundmusik. Zahlen + Einheiten leiden zuerst.
2. **Prompt-Tightening fehlt**: System-Prompt sagt nicht explizit
   "Zahl+Einheit gehört IMMER in quantity+unit EINER Zutatenzeile,
   NIE in description oder note".
**Likely fix — 3 Optionen, 1+2 kombinierbar:**
1. **Prompt-Härtung** (`recipe_extraction.py:130-170`, billig):
   Zusatzabsatz: *"Wenn du eine Zahl mit Einheit hörst ('200 g',
   '500 ml', '3 EL'), gehört sie IMMER in `quantity` + `unit` einer
   Zutat-Zeile. Niemals in `description`, `note` oder andere Felder.
   Bei Unsicherheit setze `confidence='uncertain'` UND ordne die
   Menge trotzdem einer Zutat zu — lieber unsicher-mit-Menge als
   sicher-ohne-Menge. NIEMALS Portionszahl ('2 Personen') als
   Zutatenmenge interpretieren."*
2. **Post-Process-Validator** (`post_process.py`, defense-in-depth):
   Regex-Scan auf `description` + `ingredient.note` nach Mustern
   `\b\d{1,4}\s*(?:g|kg|ml|l|EL|TL|Stück|Prise)\b`. Bei Treffern
   Variante (a): confidence der umgebenden Zutat auf `uncertain`
   downgrade + loggen. Variante (b): Menge heuristisch auf
   matching-named Ingredient im Kontext-Window zuordnen. (a) ist
   low-risk, (b) mächtiger aber kann Fehl-Zuordnungen machen —
   (a) empfohlen für ersten Fix.
3. **Whisper-language-Hint + Temperature**: wenn Audio-Sprache
   detected als "de" → Whisper mit `language="de", temperature=0.0`.
   Reduziert Zahlen-Halluzinationen. Eigener Slice-Scope.
**Priority:** medium — Fix 1+2 zusammen dämpfen deutlich. Option 3
ist größer.
**Test-Strategie:** Domain-Logic-Bug → Unit-Test:
- `test_post_process.py`: Theory mit 4 Cases:
  - description "Klassischer Auflauf" + normale Zutaten → no warn.
  - description "ca. 500 g Fleisch dazu" + Zutat Fleisch null-qty →
    warn (auto-attach in Variante b).
  - Zutat Fleisch note "900 g" + quantity=2 → warn + confidence-
    downgrade.
  - description "2 Personen" + Zutat Fleisch qty=2 → prompt-level
    Abdeckung via mock-LLM-Integration-test.
- `test_photo_prompts.py` / `test_url_prompts.py`: grep-style assert
  dass SYSTEM_PROMPT_DE die Wörter "quantity", "description" und
  "NIEMALS" im gleichen Absatz enthält (prompt-regression-gate).


---

## BUG-029 · Zutaten-Name-Input ist auf Mobile zu schmal (Textabschnitt)
**Reported:** 2026-04-20 (URL-Beispiel: `facebook.com/share/r/18Ue6Nh8Xp/?mibextid=wwXIfr`)
**Status:** `[x] fixed` (2026-04-20 — mobile stacked layout (name full-width row, qty+unit sub-row below) via flex-col + md:grid-cols-[92px_96px_1fr]; regression-grep-gate + order-check test)
**Severity:** HIGH — User sieht Zutaten-Namen nicht; wirkt als wären
Zutaten leer / nicht extrahiert. Ursprünglich als Whisper/Azure-Bug
verdächtigt, User hat bei Live-Test erkannt: Daten sind da, das
Input-Feld ist einfach zu schmal.
**Where:** `apps/web/src/features/recipes/RecipeFormPage.tsx:1475` —
inneres Zutaten-Grid:
```
grid grid-cols-[92px_96px_1fr]
```
plus äußeres Row-Grid bei line 1459:
```
grid grid-cols-[28px_1fr_auto] ... pl-1 pr-2.5
```
**Symptom:** Auf iPhone SE (375 px) nach Viewport-Rechnung:
- Card-Padding + Ring ~20 px → ~335 px nutzbar
- `pl-1 pr-2.5` (14 px) → 321 px
- Drag-Handle 28 + gap 8 = 36 px → 285 px
- Delete-Spalte ~48 px → ~237 px innen
- Menge 92 + Einheit 96 + Gaps 12 = 200 px fest verbraucht
- **Name bekommt: ~37 px** — ca. 3 Buchstaben sichtbar.
**Root cause:** 3-Spalten-Grid (Menge / Einheit / Name) in einer
horizontal eng begrenzten Zeile. Menge + Einheit nehmen zusammen
188 px fest — Mobile hat nicht genug Rest für den wichtigsten Wert
(den Zutaten-Namen).
**Likely fix — 3 Optionen, Vorschlag Option 1:**
1. **Stacked Layout auf Mobile** (empfohlen): Name oben full-width,
   Menge + Einheit in einer Zeile darunter. Konkret:
   ```
   mobile: flex-col; name full-width; below [menge-96px][einheit-96px]
   md+:    unverändert grid-cols-[92px_96px_1fr]
   ```
   Pro: Name bekommt ~285 px = deutlich genug; Menge+Einheit teilen
   sich die folgende Zeile großzügig. Kontra: Row wird ~12 px höher
   auf Mobile (nicht tragisch, Zutaten-Liste scrollt ohnehin).
2. **Shrink Menge + Einheit**: 92 → 64, 96 → 72. Rettet 52 px → Name
   bekommt ~89 px. Noch grenzwertig bei langen Namen wie
   "Tomatenmark".
3. **Name-First-Layout** (UX-Win): Name primary ganz oben, Menge +
   Einheit in "kleiner"-Typo-Zeile darunter. Entspricht wie Kochbücher
   es schreiben ("Mehl — 500 g"). Kontra: visuell Umgewöhnung.
**Kombinierbar**: Option 1 oder 3 + Option 2 für md-Breakpoint-Tuning.
**Priority:** HIGH — blockiert Review von Video-/Foto-Imports auf
Mobile wo 90% der User das Formular öffnen.
**Test-Strategie:** CSS/Layout-Bug laut Regression-Test-Policy:
- `RecipeFormPage.test.tsx`: render mit prefill + 375×667 viewport,
  assert das Name-Input `getBoundingClientRect().width >= 150` (nach
  Fix). Grep-Gate: assert dass `grid-cols-[92px_96px_1fr]` nicht
  mehr ohne `flex-col md:grid` davor auftritt.
- Optional Playwright mit 3 Ingredient-Namen unterschiedlicher Länge
  (kurz/mittel/lang) → screenshot-compare dass keiner abgeschnitten
  wird.

---

## BUG-030 · Imperial- und Englisch-Einheiten in Import-Ergebnissen
**Reported:** 2026-04-20
**Status:** `[x] fixed` (2026-04-20 — SYSTEM_PROMPT_DE in beiden
Prompt-Dateien mit metric-only-Direktive + Umrechnungs-Tabelle;
`_translate_unit` helper im `post_process.py` mit 14+ unit mappings
(oz/lb/cup/tbsp/tsp/fl oz/clove/stick/pinch/slice/bunch/piece),
integriert in `_normalise_ingredient`; ~20 neue Python-Tests (theory-
sweep für `_translate_unit`, End-to-End-Integration durch
`_normalise_ingredient` + `post_process`, Prompt-Regression-Gates in
`test_recipe_prompts.py` und `test_photo_prompts.py`).)
**Severity:** medium (Daten-Hygiene — User muss bei amerikanischen
Quellen manuell umrechnen; Rezept passt sonst nicht in unsere
metrische UI)
**Where:** `apps/python-extractor/src/extractor/prompts/recipe_extraction.py`
+ `photo_recipe.py` SYSTEM_PROMPT_DE; `pipeline/post_process.py`
`_normalise_ingredient`. Plus Frontend-Unit-Liste in
`apps/web/src/features/recipes/RecipeFormPage.tsx` Dropdown bei
`UNITS`.
**Symptom:** Bei Import amerikanischer/englischsprachiger Videos
landen Zutaten mit `unit: "oz"`, `"cloves"`, `"cups"`, `"tbsp"`,
`"tsp"`, `"lb"`, `"fl oz"`. User-Beispiel: "16 oz Hackfleisch",
"4 cloves Knoblauch". Unsere Unit-Dropdown kennt diese nicht → stehen
als freie Strings da, keine Skalierung möglich.
**User-Direktive:** "also metrisch und deutsch die mengenangaben".
**Root cause:** Prompt sagt nur "Deutsch" für Texte aber nicht
explizit "metrisches System, deutsche Maßeinheiten". Post-Process
normalisiert Unit-Strings nicht.
**Likely fix — 2 Schichten (beide):**
1. **Prompt-Härtung** (SYSTEM_PROMPT_DE in beiden Prompt-Dateien):
   Neuer Absatz (auf Deutsch, wie der Rest): *"Alle Mengenangaben
   MÜSSEN metrisch und auf Deutsch sein: `g` / `kg` / `ml` / `l` /
   `EL` / `TL` / `Stück` / `Prise` / `Bund` / `Tasse` / `Becher` /
   `Scheibe` / `Zehe`. Rechne imperial-Einheiten um: 1 oz = 28 g,
   1 lb = 454 g, 1 cup = 240 ml, 1 tbsp = 15 ml, 1 tsp = 5 ml,
   1 clove = 1 Zehe, 1 stick = 113 g. Gebe die Menge in der
   umgerechneten Einheit zurück, keine imperial-Strings im
   Output."*
2. **Post-Process-Fallback** (`post_process.py` `_normalise_ingredient`):
   Mapping-Dict wenn LLM trotz Prompt-Anweisung imperial
   durchlässt:
   ```
   UNIT_TRANSLATIONS = {
       "oz": ("g", 28.35),          "ounce": ("g", 28.35),
       "ounces": ("g", 28.35),
       "lb": ("g", 453.6),          "pound": ("g", 453.6),
       "pounds": ("g", 453.6),
       "cup": ("ml", 240),          "cups": ("ml", 240),
       "tbsp": ("ml", 15),          "tablespoon": ("ml", 15),
       "tsp": ("ml", 5),            "teaspoon": ("ml", 5),
       "fl oz": ("ml", 29.57),      "fl. oz.": ("ml", 29.57),
       "clove": ("Zehe", 1),        "cloves": ("Zehe", 1),
       "stick": ("g", 113),         "sticks": ("g", 113),
       "pinch": ("Prise", 1),       "pinches": ("Prise", 1),
       "slice": ("Scheibe", 1),     "slices": ("Scheibe", 1),
       "bunch": ("Bund", 1),        "bunches": ("Bund", 1),
       "piece": ("Stück", 1),       "pieces": ("Stück", 1),
   }
   ```
   Wenn `unit.lower().strip()` ein Match ist: `new_unit, factor =
   UNIT_TRANSLATIONS[key]`; `quantity = str(round(float(quantity) *
   factor))`. Preserviert `confidence` + `note`. Bei Parse-Fail
   `quantity` unverändert + `confidence="uncertain"`.
**Priority:** medium — stört bei amerikanischen Quellen, passiert
aber seltener als deutsche Rezepte. Bundle-Kandidat mit nächster
Prompt-Runde.
**Test-Strategie:** Domain-Logic-Bug → Unit-Test:
- `test_post_process.py`: Theory mit 10 Cases, einer pro
  UNIT_TRANSLATIONS-Key plus edge-cases (leading/trailing whitespace,
  mixed-case "OZ", deutsche Durchreiche "g" unchanged).
- `test_recipe_prompts.py`: grep dass SYSTEM_PROMPT_DE "oz", "cups",
  "tbsp" mit Umrechnung enthält.
- Frontend: kein Test nötig — Dropdown-Unit-Liste muss nur eines der
  übersetzten deutschen Werte enthalten können (ist sie alle schon).

---

## BUG-031 · Video-Progress bleibt bei 5% auch nach BUG-027-Fix (Ramp im falschen Layer)
**Reported:** 2026-04-20 (nach v0.8.0-Deploy, User: "hängt nach wie vor bei 5%")
**Status:** `[x] fixed` (2026-04-20 — Ramp-Logik aus `_make_ytdlp_progress_wrapper` entfernt; neue `_RAMP_PHASES`/`_RAMP_RATE`/`_RAMP_MAX` Konstanten in `progress.py`; `_heartbeat_loop` berechnet `elapsed*3` capped at 95 und emittiert `max(_last_phase_progress, ramped)`; `start_heartbeat` snapshot'd `_phase_start_monotonic` (kein Reset von `_last_phase_progress` — die Pipeline ruft bereits `report(phase, 0)` vor jedem `start_heartbeat`). 4 neue Heartbeat-Tests (ramp-when-silent, respects-real-progress, caps-at-95, skips-ramp-on-non-ramp-phases); obsoleter `test_ytdlp_wrapper_uses_elapsed_time_when_total_unknown` entfernt. 357 Python-Tests grün, ruff + mypy clean.)
**Severity:** HIGH — Regression-Fix für BUG-027.
**Where:**
- `apps/python-extractor/src/extractor/pipeline/video.py:317-399` —
  `_make_ytdlp_progress_wrapper` enthält die elapsed-time-Ramp
  `min(95, int(elapsed * 3))`. Läuft **nur wenn yt-dlp den
  `progress_hook` aufruft**. Bei FB-Reels mit single-blob-download
  (kein HLS-Fragment-Ticken) ruft yt-dlp den Hook **nie** auf → Ramp
  fired nie → `_last_phase_progress` bleibt 0.
- `apps/python-extractor/src/extractor/progress.py:248-283` —
  `_heartbeat_loop` feuert alle 2 s mit `force=True`, aber re-emittiert
  nur `self._last_phase_progress`. Bei 0 bleibt's bei 0.
**Root cause:** Elapsed-Time-Ramp im falschen Layer. Reactive an
yt-dlp-Hook-Calls statt proactive im Timer. Bei stillen Downloads
(yt-dlp-Hook-Silence) greift sie nie.
**Fix — empfohlen:** Ramp-Logik in den Heartbeat-Loop verschieben.
- `start_heartbeat(phase)` merkt sich `_phase_start_monotonic = time.monotonic()`.
- `_heartbeat_loop`: wenn `phase in {"downloading","transcribing","structuring"}`:
  ```python
  elapsed = time.monotonic() - self._phase_start_monotonic
  ramped = min(95, int(elapsed * 3))
  effective = max(self._last_phase_progress, ramped)
  await self.report(ProgressEvent(phase=phase, phase_progress=effective), force=True)
  ```
- `max(last, ramped)` — echte yt-dlp-Werte overriden Ramp wenn höher.
- `_make_ytdlp_progress_wrapper` verliert die Ramp-Logik (DRY,
  Heartbeat ist single-source). Fragment-count + byte-total-Priorität
  bleibt erhalten.
**Test-Strategie:** Unit-Tests im Progress-Reporter:
- `test_heartbeat_ramps_when_yt_dlp_silent`: nach 4 s fast-forward →
  phase_progress ≈ 12.
- `test_heartbeat_respects_real_progress`: `report(50)` bei 2 s,
  nächster Tick bei 4 s → `max(50, 12) = 50`.
- `test_heartbeat_caps_at_95`: nach 40 s → 95.
- `test_pipeline_video`: bestehende fragment-count + byte-Tests
  bleiben; elapsed-Tests wandern auf Heartbeat-Seite.
**Rollback-Risiko:** gering — Python-only, keine Schema-Änderung.

---

## BUG-032 · Bottom-Menüs überlappen / schieben sich übereinander (mehrere Suspects)
**Reported:** 2026-04-20 (User: "die menüs bzw bottom menüs wie tab bar
und in wochenplan oder so schieben dich teilweise immer noch übereinander
oder untereinander")
**Status:** `[x] fixed` (2026-04-20 — GroupDetailPage FAB z-20→z-40 +
bottom now follows `var(--bottom-nav-height)` + `var(--viewport-bottom-offset)`
so it tracks BottomNav on iOS/Chrome toolbar retract; new
`--topnav-height: 56px` CSS var in `apps/web/src/index.css`;
sticky sub-navs in MealPlanPage, ShoppingListPage, GroupDetailPage
and GroupSettingsPage migrated from `top-[56px] z-20` to
`top-[var(--topnav-height)] z-10` so the global TopNav at z-20 wins
any y-overlap; new grep-gate `test/tokens/bottom-anchors.test.ts`
regression-catches sticky `top-[NNpx]` and inline
`bottom: 'calc(NNpx…)'`; Suspect 3 (ChatPage sticky) already
clean — the scrollable container height already carves out the
BottomNav strip so the sticky bottom-0 inside it cannot reach the
BottomNav.)
**Severity:** medium (UX — visual chaos auf Mobile-Scroll; teilweise
Buttons unklickbar hinter anderen Bars)
**Recherche-Ergebnis:**

### Suspect 1 (HIGH — wahrscheinlicher Haupt-Bösewicht)
`apps/web/src/features/groups/GroupDetailPage.tsx:326-342` — FAB
("Neues Rezept"):
```
z-20
style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
```
- **z-20 < BottomNav z-30** → bei Overlap gewinnt BottomNav, FAB
  versteckt sich dahinter.
- **bottom-Calc referenziert NICHT `var(--viewport-bottom-offset)`** (aus
  BUG-023). Wenn iOS-Chrome retractet, bewegt sich BottomNav via der
  Variable nach oben mit dem Visual-Viewport — FAB bleibt auf statischer
  `96px + safe-area` Position → FAB sitzt jetzt weiter UNTEN relativ
  zur BottomNav als designed → kann unter die BottomNav rutschen.
- **Literal `96px`** statt `--bottom-nav-height` Token. Wenn BottomNav-
  Höhe ändert, FAB-Offset ist hart-verdrahtet falsch.

### Suspect 2 (medium)
`apps/web/src/features/mealplanning/MealPlanPage.tsx:393-397` +
`apps/web/src/features/shoppinglist/ShoppingListPage.tsx:258` — beide
haben eine `sticky top-[56px] z-20`-Sub-Nav (Wochen-Navigation /
Kategorie-Sort-Toggle).
- Sticky `top-[56px]` geht davon aus TopNav ist genau 56 px hoch.
- Bei iOS-Chrome-Retract vergrößert sich Visual-Viewport; die sticky-
  Position bleibt bei 56 px vom Top des LAYOUT-Viewports — das ist
  nicht mehr unter der TopNav sondern drunter oder überlappend.
- `z-20` = TopNav-z-20 = keine klare Stacking-Ordnung bei Overlap.
- **User's "in Wochenplan"-Erwähnung**: wenn Sub-Nav während Scroll
  unter oder über die TopNav rutscht, sieht es aus als würden sich
  zwei Bars übereinander-schieben.

### Suspect 3 (low, aber vorhanden)
`apps/web/src/features/chat/ChatPage.tsx:551` + 579 —
`sticky bottom-0` Input-Bar + `sticky bottom-4 z-10` "In Rezept
umwandeln"-CTA. Sticky heißt: scrollt mit dem Container, nicht mit
dem Viewport. Sollte nicht mit BottomNav kollidieren, weil die
Container-Bounds vor der BottomNav enden. **Aber**: wenn
`container height = 100dvh` dynamisch wächst (chrome-retract), könnte
der Container bis an den visual-bottom reichen und dann liegt das
Sticky direkt auf der BottomNav.

### Fix-Plan — 3 Schichten, kombinierbar:
1. **GroupDetailPage FAB fixen** (der höchste Impact):
   - `z-20` → `z-40` (über BottomNav-z-30).
   - `bottom: 'calc(96px + env(...))'` → `bottom: 'calc(var(--bottom-nav-height)
     + env(safe-area-inset-bottom, 0px) + var(--viewport-bottom-offset, 0px)
     + 20px)'`. Das `+20px` ist der Luftabstand zwischen BottomNav und FAB.
   - Damit folgt der FAB automatisch BottomNav-Höhe + Viewport-Offset.
2. **Sticky-Top-Sub-Nav fixen** (MealPlan + ShoppingList):
   - Option A: Statt `top-[56px]` eine CSS-Variable `--topnav-height`
     benutzen, analog zu `--bottom-nav-height`. TopNav setzt sie selbst
     (via ResizeObserver oder festem Wert).
   - Option B: Sub-Nav auf `top-0` setzen und die TopNav selbst als
     "normaler Flow"-Element (nicht sticky) umbauen — Sub-Nav übernimmt
     die Sticky-Rolle. Weniger invasiv: Option A.
   - z-Index: Sub-Nav auf `z-10`, TopNav bleibt `z-20`. Bei Überlappung
     gewinnt TopNav, nicht 50/50-Chaos.
3. **ChatPage Sticky-Bottom + BottomNav-Luftraum**:
   - Chat-Container muss `pb-[var(--bottom-nav-height)]` als
     bottom-padding haben, damit die Sticky-Input-Bar NIE in die
     BottomNav-Zone reicht.

### Test-Strategie (CSS/Layout):
- `GroupDetailPage.test.tsx`: Grep-Gate dass der FAB-`bottom: 'calc(...)'`
  KEINEN hart-verdrahteten `96px`-Wert mehr enthält + enthält beide
  `--bottom-nav-height` UND `--viewport-bottom-offset` im calc.
- Neue Regression-Gate-Test-Datei `test/tokens/bottom-anchors.test.ts`:
  scant alle `.tsx`-Files nach `bottom: 'calc(\d+px` oder
  `bottom-\[\d+px\]` in fixed-positioned Elementen. Assertion: kein
  hart-verdrahteter px-Wert in bottom-Formeln OHNE die zwei Variablen.
- `MealPlanPage.test.tsx` + `ShoppingListPage.test.tsx`: assert dass
  der Sub-Nav einen z-Index < 20 hat (hilft gegen 50/50-Stacking).
- Playwright: iPhone-SE-Profile, scroll bis Chrome retracts, assert
  `getBoundingClientRect()` von BottomNav und FAB überlappen sich nicht.

### Priority
Medium. Nicht funktions-brechend, aber deutlich unprofessionell bei
häufigem Scrollen. Bundle-Kandidat in der nächsten Mobile-Polish-Welle.

### Rollback-Risiko
Gering — reine CSS-Layer-Korrekturen, keine Daten/API-Änderungen.

---

## BUG-033 · Video-Caption-URL: Kein Rezept extrahiert obwohl Link in Caption
**Reported:** 2026-04-20 (URL: `facebook.com/share/r/18nmn8B7mU/?mibextid=wwXIfr`
— User vermutet "war ein Link in der Caption")
**Status:** `[ ] open`
**Severity:** medium (Feature-Lücke — Caption-Link-Follow existiert via
P2-2.1, aber greift nicht für alle FB-Reel-Muster).
**Where:**
- `apps/python-extractor/src/extractor/pipeline/url.py:173-183` —
  `_SHORTENER_HOSTS` frozenset filtert `bit.ly`, `tinyurl.com`,
  `lnk.bio`, `linktr.ee`, `t.co`, `ow.ly`, `buff.ly`. FB-Reels packen
  die Rezept-URL oft als **bit.ly**- oder **linktr.ee**-Verkürzer in
  die Caption, weil die native FB-Preview-Handling kürzer wirkt.
- `apps/python-extractor/src/extractor/pipeline/url.py:115-` —
  `_VIDEO_HOSTS` filtert Cross-Recursion auf IG / TikTok / YouTube.
  Korrekt, nicht Teil des Bugs.
**Prod-Evidenz** (Import `5da20fda-…`, Video `18nmn8B7mU`):
- Status=`done`, ingredients=[], steps=[], title="Unbekanntes Rezept"
- Azure tokens: 1229 prompt + 516 completion → Whisper-Transkript
  kam durch, Azure hat analysiert und gesagt "kein Rezept"
- thumbnail_url ist da (yt-dlp Metadaten funktionierten)
- **Keine Caption-URL-Follow-Log-Einträge** in API/Python-Logs.
**Root-cause-Hypothesen:**
1. **Shortener-Filter greift zu breit** — wenn die Caption
   `"Rezept: https://bit.ly/xyz"` enthält, wird das silent gedropped
   statt per HEAD-request geresolved + gecrawled.
2. **Caption hatte gar keinen Link** — Video ist wirklich kein Rezept.
   Dann ist Pipeline OK, aber UX (BUG-034) fehlt.
3. **Link war da aber Regex hat nicht gematcht** — z.B. Zero-width-
   spaces, Unicode-Escapes, oder Tracking-Parameter die den URL-
   Regex-Terminator früh triggern.
**Fix-Plan (3 Optionen, kombinierbar):**
1. **Shortener auflösen statt dropped**:
   Neuer Helper `_resolve_shortener(url, max_redirects=3)` macht
   einen HEAD-request mit 5s-Timeout, extrahiert `Location`-Header,
   resolved bis zur finalen URL (oder max 3 redirects). Dann die
   `_VIDEO_HOSTS`/`same-host`-Filter auf die finale URL anwenden.
   Pro: echte Coverage für FB-Reels mit Shortenern. Kontra: eine
   extra HEAD-request pro Caption mit Shortener (rate-limit-OK,
   shorteners ratelimiten nicht aggressive).
2. **Caption ins ResultJson persistieren** (Debug-UX):
   Neuer Feld `recipe.caption_excerpt: str` auf ResultJson mit den
   ersten ~500 Chars der Caption. Dann kann User in einem Debug-
   Panel sehen was Azure überhaupt zum Analysieren hatte → schließt
   "Hypothese 2" aus ohne Prod-DB-Inspect.
3. **Caption-URL-Follow-Log auf INFO heben**: aktuell silent; bei
   match loggen "caption_url_followed src=<host> target=<host>"; bei
   filter-skip loggen "caption_url_skipped reason=shortener/video".
   Kein Code-Fix, nur Observability — dann sehen wir zukünftig welche
   Filter-Regel greift.
**Empfohlen:** (3) zuerst zum Debuggen, dann (1) wenn bestätigt dass
Shortener-Filter Hauptursache ist.
**Priority:** medium — nicht kritisch, aber häufiges Failure-Pattern
bei Short-Form-Video-Apps.
**Test-Strategie:**
- `test_extract_caption_blog_url`: neuer Case mit bit.ly + mock
  HEAD-response → assert dass die resolved-URL zurückkommt, nicht null.
- `test_extract_caption_blog_url_max_redirects`: bit.ly → goo.gl →
  blog.example → assert follow, aber nach max 3 redirects stop.
- Regression: alle bestehenden 6 Tests in `test_pipeline_url.py` für
  Caption-URL-Parsing müssen grün bleiben.

---

## BUG-034 · Leeres Extraktions-Ergebnis: UX zeigt leeres Formular statt Fehler
**Reported:** 2026-04-20 (User: "wenn kein rezept extrahiert werden kann
sollte das so angezeigt werden mit begründung und nicht ein leeres
rezept formular")
**Status:** `[x] fixed` (2026-04-20) — post_process quality-gate (`recipe_empty`
+ `empty_reason` auf `ExtractionResult`), shared TS round-trip Mirror,
`EmptyExtractionExplainer` + `RecipeFormPage`-Wrapper-Branch mit
`proceedAnyway`-Escape-Hatch. Nur `"no_recipe_detected"` feuert aus
post_process; `"empty_transcript"` bleibt als Enum-Reserve für den
BUG-033-Pipeline-Gate. Siehe Progress-Tracker Slice `BUG-034`.
**Severity:** HIGH — macht Pipeline-Failures wie echte Funktionsbugs
aussehen; User kann nicht unterscheiden ob's der Extractor oder das
Video war.
**Where:**
- **Backend**: `apps/python-extractor/src/extractor/pipeline/post_process.py`
  returnt current einen Erfolg-Result auch wenn `ingredients=[]` UND
  `steps=[]`. Der API-Job `ExtractRecipeFromUrlJob` speichert das als
  `Status=Done`.
- **Frontend**: `apps/web/src/features/recipes/RecipeFormPage.tsx`
  rendert bei done-status + leerem Prefill das normale Formular — ohne
  jede Information dass etwas fehlgeschlagen ist.
**Symptom:** User sieht nach Video-Import ein fast-leeres Formular
(nur Fallback-Title "Unbekanntes Rezept", manchmal ein Thumbnail),
denkt "Extraktor kaputt". Tatsächlich hat Azure das Video bewusst
als "kein Rezept" klassifiziert.
**Root cause:** Keine Quality-Gate-Schicht zwischen "pipeline
terminated ohne Exception" und "ergab ein brauchbares Rezept". Der
Azure-Fallback-Title und Confidence "low" sind vorhanden aber werden
nicht als UI-Signal verwendet.
**Fix-Plan (Schichten, vollständig):**
1. **Backend quality-gate** (`post_process.py`):
   Nach dem Normalize-Loop: wenn
   `len(ingredients) == 0 AND len(steps) == 0`, neuer Top-level-Flag
   `result.recipe_empty = true` + `result.empty_reason: str` mit
   einem aus drei Werten:
   - `"no_recipe_detected"` (Default — Azure hat leeres Rezept
     zurückgegeben, Transkript war nicht-rezeptartig)
   - `"empty_transcript"` (wenn Whisper-Transkript < 40 Chars war
     — separater Gate im url.py pipeline)
   - `"extractor_error"` (sollte zu `Status=Error` gehen statt hier,
     aber als Fallback)
2. **Shared type** (`packages/shared/src/types/import.ts`):
   `ExtractionResult` bekommt `recipeEmpty?: boolean` +
   `emptyReason?: 'no_recipe_detected' | 'empty_transcript' | 'extractor_error'`.
3. **Frontend** (`RecipeFormPage.tsx` wrapper):
   Vor `<RecipeFormInner>` branchen:
   ```tsx
   if (prefill?.recipeEmpty) {
     return <EmptyExtractionExplainer
       reason={prefill.emptyReason}
       sourceUrl={prefill.sourceUrl}
       onRetry={() => navigate('/rezepte/import?url=' + ...)}
       onProceedEmpty={() => setProceed(true)}  // state to skip the gate
     />
   }
   ```
4. **Neue Component** `EmptyExtractionExplainer.tsx`:
   - Heading: "Kein Rezept erkannt"
   - Body mit Reason-Erklärung:
     - `no_recipe_detected`: "Aus diesem Video konnte kein Rezept
       extrahiert werden. Möglicherweise enthält das Video kein
       Kochrezept, oder der gesprochene Inhalt reicht nicht aus."
     - `empty_transcript`: "Das Video enthielt keinen verwertbaren
       Audio-Inhalt (nur Musik oder stumm)."
     - `extractor_error`: "Bei der Analyse ist ein Fehler aufgetreten."
   - Zwei Buttons: **"Anderes Video probieren"** (→ `/rezepte/import`)
     + **"Trotzdem als leeres Rezept anlegen"** (proceed-flag → regular
     form mit nur Thumbnail).
   - Debug-collapsible "Was hat der Extractor bekommen?" zeigt
     Caption-Excerpt (falls BUG-033-Option-2 implementiert ist).
**Priority:** HIGH — bundle-Kandidat mit BUG-033 (Caption-Follow)
für die "Video-Import Quality"-Fix-Welle. (3)+(4) können standalone
landen, (1)+(2) brauchen Schema-Update + Migration-koordinierten
Deploy.
**Test-Strategie:**
- **Backend**: `test_pipeline_post_process.py` — Theory mit 3 Cases:
  leere ingredients+steps → recipe_empty=true + reason passend;
  volle Zutaten → recipe_empty=false + reason=None;
  leere nach dedupe (BUG-022) aber nicht Azure → recipe_empty=true.
- **Shared**: type-round-trip test.
- **Frontend**: `RecipeFormPage.test.tsx` — neue Tests:
  render mit prefill.recipeEmpty=true → `EmptyExtractionExplainer`
  rendert, `RecipeFormInner` NICHT; Click "Trotzdem anlegen" → flippt
  auf Inner; Click "Anderes Video" → Navigation zu `/rezepte/import`.
