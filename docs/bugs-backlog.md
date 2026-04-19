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
**Status:** `[ ] open`
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
**Status:** `[ ] open`
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
**Status:** `[ ] open`
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
**Status:** `[ ] open`
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
**Status:** `[ ] open`
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
**Status:** `[ ] open`
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
**Status:** `[ ] open`
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
**Status:** `[ ] open`
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
**Status:** `[ ] open`
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
**Status:** `[ ] open`
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
**Status:** `[ ] open`
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
(`https://kochbuch.kaulig.dev/api/photos/...`), muss Azure Vision sie
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
**Status:** `[ ] open`
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
**Status:** `[ ] open`
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
**Status:** `[ ] open`
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
