# Feature Draft — "Jetzt Kochen"-Modus

**Date:** 2026-04-21
**Status:** 💡 Idea — noch nicht eingeplant, wartet auf grünes Licht
**Use-case-Ursprung:** User-Brainstorm 2026-04-21: "jetzt kochen modus
wo man erst die zutaten sieht und dann die steps durchklicken oder
sowas"

## Pitch

Heute rendert die Rezept-Detail-Seite Zutaten + Schritte parallel
auf einer scrollbaren Seite. Am Herd mit mehligen Fingern auf dem
Tablet ist das suboptimal: man scrollt verloren, die Typo ist zu
klein, man verliert den Faden welcher Schritt gerade dran ist.

**Jetzt-Kochen-Modus** ist eine **Fullscreen-Stage** — Rezept läuft
step-by-step ab, eine grosse Action pro Screen, minimales Chrome,
Wake-Lock verhindert dass das Display einschläft.

## User-Flow

1. **Entry**: neuer primary Button auf `RecipeDetailPage`, direkt
   neben "Jetzt gekocht": **"Jetzt kochen"** (Chef-Hat-Icon).
2. **Mise-en-Place-Screen (Step 0)**: Zutaten als Checkliste,
   scaled mit dem aktuellen Portionsslider. Je Zutat ein grosser
   Tap-Target (~52 px) der abhakt. Unten Button "Los geht's".
3. **Step-Screens (1..N)**: volle Viewport-Stage. Header mit
   "Schritt X/N" + Progress-Dots. Body mit der Step-Nummerierung +
   dem Text in grosser Typo (Inter 22–26 px, line-height 1.5).
   Darunter: eingebetteter **Zutaten-Mini-Hinweis** — wenn der Step-
   Text eine Menge erwähnt (regex `\d+(g|ml|EL|TL|...)`), unterstreicht
   die passende Zutat aus der Mise-en-Place-Liste als Chip.
   Optional: **Inline-Timer-Chips** — wenn Step-Text "3 Minuten" /
   "10-15 min" enthält, neben dem Text ein ⏱-Chip zum Tap-to-start.
   Footer: Back-Arrow + "Fertig / Weiter"-Button.
4. **Abschluss-Screen**: "Geschafft! Möchtest du das Rezept als
   gekocht markieren?" + "Jetzt gekocht"-Primary-Button +
   "Schliessen"-Ghost. Bei Bestätigung: fire die bestehende
   `onMarkCooked`-Mutation (bereits auf der Detail-Page vorhanden).

## UX-Invarianten

- **Screen bleibt an**: `navigator.wakeLock.request('screen')` beim
  Betreten; Release beim Verlassen. Prompt an den User wenn Wake-Lock
  abgelehnt ("iOS fragt nicht immer — du müsstest Auto-Sleep in den
  System-Settings deaktivieren").
- **Navigation-Shortcuts**: Swipe-Left/Right zwischen Steps.
  Keyboard `→ / ← / Space`. Volume-Buttons (nice-to-have, braucht
  ScreenOrientation-API-Hack).
- **Portionen-Scaler bleibt aktiv**: gleicher Slider-State wie auf
  Detail-Page. User wechselt Portionen → Zutaten werden on-the-fly
  rescaled.
- **Exit**: top-left "X" + Browser-Back → Bestätigungs-Dialog
  "Kochmodus wirklich beenden? Fortschritt geht verloren."
  (soft-warning, User kann aber immer abbrechen).

## Technische Skizze

### Neue Route + Page

- Route: `/groups/:groupId/recipes/:recipeId/cook`
- Component: `CookModePage` in `apps/web/src/features/recipes/cook/`
- Reuses: `useRecipeDetail`, `useRatePortionSlider` (or equivalent
  shared portion-state) — liest aus dem Recipe-Cache via TanStack
  Query, muss keinen neuen Fetch machen wenn Cache warm.
- State lokal pro Cook-Session (currentStep, checkedIngredients,
  activeTimers) — nicht persistiert.

### Komponenten-Tree

```
CookModePage
├─ CookTopBar (X-Close + Step-Count)
├─ CookStepStage
│   ├─ (step=0) MiseEnPlaceList
│   │   └─ IngredientCheckRow (tap-to-check)
│   └─ (step=1..N) CookStepCard
│       ├─ StepText (big typo + regex-chip highlighting)
│       └─ InlineTimerChip (optional)
├─ CookBottomBar (← Zurück | Weiter/Fertig →)
└─ WakeLockEffect (hook)
```

### Timer-Extraction

Pure helper: `extractTimers(stepText: string) => { label: string; seconds: number }[]`.
Regex-Liste für DE: `(\d+)\s*(min|minuten|std|stunde[n]?|sek|sekunden)`
+ Range-Form `(\d+)\s*[-–]\s*(\d+)\s*(min|…)` → nimmt die Mitte oder
den oberen Wert (Dokumentation im Helper).
Timer-State: **pause-/resume-bar** mit Fortschritts-Ring. Bei 0 →
Vibrations-API (`navigator.vibrate`) + Sound (optional Silent-Mode-
Bypass über Web Audio API). Läuft WEITER wenn User den Step wechselt
(Timer überlebt Navigation).

### Shared-Helper für Zutaten-Highlight

`highlightQuantitiesInStep(stepText: string, ingredients: Ingredient[]) => Token[]`
Token = Plain-Text oder Chip mit `ingredientId`. Rendering-Seite
stylt die Chips unterschiedlich + scrollt die Mise-en-Place-Liste
die abgehakten Zutaten an.

### Keine Backend-Änderungen notwendig

- Recipe-Daten kommen aus dem bestehenden `GET /api/recipes/:id`.
- "Als gekocht markieren" nutzt die bestehende Mutation
  (`POST /api/recipes/:id/cook` oder PATCH mit `isCooked=true` —
  je nachdem wie es heute gebaut ist; grep `onMarkCooked` für den
  aktuellen Pfad).

## Roadmap-Einordnung

Dieses Feature ist **sehr im Spirit** von Phase 5 (PWA am Herd) und
überschneidet sich teilweise mit dem bestehenden Portion-Scaler.
Gute Einordnung wäre:

- **Phase 4 (Smart-Features) Teil-Slice COOK1** — standalone-able,
  keine AI-Dependencies, perfekter Anlauf-Slice um Phase 4 zu starten.

ODER

- **Standalone-Slice zwischen Phase 5 und Phase 4**, weil der
  User das Feature gerade frisch im Kopf hat und es PWA-nah ist.

## Offene Design-Fragen

1. **Step-Reading-Modus vs. Hands-Free-Modus**: Sollen wir Voice-
   Control ergänzen ("Hey Kochbuch, nächster Schritt")? Web Speech
   API ist limited auf Chrome/Edge, iOS Safari hat kein
   `SpeechRecognition`. Wäre nice-to-have, nicht blockierend.
2. **Offline-Kompatibilität**: CookModePage muss komplett offline
   funktionieren wenn Recipe im persistenten Cache ist (OFF1).
   Wake-Lock API geht offline weiter. Timer läuft offline. →
   Problemlos.
3. **Bild-Integration**: zeigen wir das Hauptbild des Rezepts als
   Hintergrund/Splash-Screen für den Mise-en-Place? Oder je Step
   ein Hero-Bild (nur wenn das Rezept eines pro Schritt hat — aktuell
   haben wir das nicht im Datenmodell, nur eine Photo-Liste am
   Rezept). Skippen für V1, ggf. später ergänzen.
4. **Multi-Session am gleichen Gerät**: wenn jemand Rezept A anfängt
   und wechselt zu Rezept B — behalten wir Step-State für A? Sehr
   low-freq use-case. V1: nein, beim Verlassen wird alles
   zurückgesetzt.
5. **Gruppen-Feature**: wenn zwei Leute am selben Gerät kochen, soll
   es ein "Zweite Person abgleicht" Pairing geben? Nein, scope-creep
   extrem. Single-device single-user.

## Tests

- Timer-Extract-Helper: 10+ Fixture-Cases (German numbers, Range-
  Forms, edge-cases wie "ein paar Minuten", "etwa 5-10 min").
- Zutaten-Highlight-Helper: 5+ Cases.
- CookModePage Integration:
  - Mise-en-Place rendert die Zutaten skaliert.
  - Step-Navigation forwards + back.
  - Wake-Lock-Request fires on mount / releases on unmount.
  - "Fertig"-Flow ruft die onMarkCooked-Mutation korrekt.
- Playwright: E2E-Happy-Path von Detail-Page → Cook-Mode → Fertig →
  zurück auf Detail-Page mit "zuletzt gekocht"-Badge.

## Umfang-Schätzung

- **MVP** (nur Durchklick-Modus, keine Timer, kein Voice,
  keine Auto-Ingredient-Highlight): ~2 Slices (impl + polish).
- **Volles Feature** mit Timer + Highlighting + Wake-Lock:
  ~4 Slices (+ CookModePage, + Helper-Library, + Timer-UI, +
  Wake-Lock-Layer + Tests).

## Offene Entscheidung für User

Vor Implementierung festlegen:

- [ ] **MVP** (nur Durchklick) oder **Vollversion**?
- [ ] **Reihenfolge**: vor Phase 4 / Teil von Phase 4 / nach Phase 4?
- [ ] **Timer-Scope**: nur explizit geklickte Timer oder auch
  auto-extrahierte Vorschläge?
