# Feature Draft — Tablet-optimiertes Layout

**Date:** 2026-04-21
**Status:** 💡 Idea — wartet auf Scope-Entscheidung
**Use-case-Ursprung:** User-Brainstorm 2026-04-21 "als design feature
für die app generell eine tablett optimierte version"

## Pitch

Die App ist heute Mobile-First (hoppr-style `fixed inset-0 flex-col`,
BottomNav). Auf dem iPad oder Android-Tablet (~768–1024 px breit)
stretcht alles entweder zur vollen Breite (unleserlich lang pro
Zeile) oder sitzt in einem schmalen `max-w-lg`-Center mit riesigem
Whitespace drumrum. Beides ist unprofessionell.

Eine **tablet-optimierte Version** nutzt die Breite sinnvoll:
Multi-Pane-Layouts, grössere Tap-Targets, Seitenleisten für
Navigation statt BottomNav, optional Split-View (Rezept-Liste +
Detail nebeneinander).

## Zielgeräte

- **iPad** (landscape + portrait)
- **Android-Tablets** (10"+, gesture-nav)
- **Foldables** (Pixel Fold / Galaxy Fold) im entfalteten Zustand
- **Kleine Laptops** / Desktop-Browser zwischen 768 px und 1280 px

Kein Desktop-Rewrite — das ist ein separater Scope. Hier ging's um
die "Zwischen-Zone" 768–1280 px.

## Kern-Layouts

### 1. Recipe-List + Detail Split-View

Heute: `/groups/:id` zeigt Rezept-Liste, Klick navigiert zu Detail-
Page (volle Breite). Auf Tablet wäre zwei-Spaltig natürlich:

```
┌─ TopNav ─────────────────────────────────────────┐
├──────────┬──────────────────────────────────────┤
│          │                                       │
│  Liste   │  Detail                               │
│  (1/3)   │  (2/3)                                │
│          │                                       │
│          │                                       │
├──────────┴──────────────────────────────────────┤
└─────────────────────────────────────────────────┘
```

Responsive: bei `md:` (768+) Split-View aktivieren, darunter bleibt
die Mobile-Single-Column-Flow unverändert.

Gilt analog für **MealPlan + Shopping-List** (Wochen-Grid links,
Details rechts) und **Chat** (Sessions-Liste links, Konversation
rechts — haben wir schon auf `md:` für Desktop, muss nur geprüft
werden dass Tablet-Breakpoint matcht).

### 2. Side-Nav statt BottomNav

Auf Tablet im Landscape-Modus ist eine BottomNav unpassend — der
Daumen läuft nicht unten lang, sondern am Rand. Hoppr macht das so:
BottomNav nur `md:hidden`, auf `md+` rendert stattdessen ein
Side-Rail (links, 72–80 px breit) mit den gleichen Nav-Icons
vertikal gestackt.

Wir machen das heute NICHT — auf `md+` verschwindet die Bottom-Nav
ohne Ersatz. → **muss** mit Tablet-Breakpoint korrigiert werden:
Side-Rail auf `md:` bis `xl:` (Tablet-Zone), dann auf `xl:` Desktop-
TopNav mit vollem Menu.

### 3. Cook-Mode Landscape

Der "Jetzt Kochen"-Modus (separater Draft
`2026-04-21-cook-now-mode-draft.md`) wäre auf Tablet im Landscape
der Haupt-Usecase — Tablet in der Küche ist der Primärzweck der PWA.
Dort zwei-spaltig: links die Mise-en-Place-Liste immer sichtbar,
rechts der aktuelle Step gross. Kein Tab-Durchklicken für Zutaten
mehr — man sieht sie permanent.

### 4. Rezept-Detail zweispaltig

Heute ein Hero + Zutaten OBEN + Steps UNTEN. Auf Tablet Landscape
könnten Zutaten + Nährwerte links sticky sein, Steps rechts
scrollbar. Dann ist die Zutaten-Liste beim Lesen des letzten
Schrittes IMMER noch sichtbar.

## Technische Skizze

### Responsive-Breakpoints-Audit

Aktuell nutzen wir Tailwind-Defaults:
- `sm:` 640
- `md:` 768
- `lg:` 1024
- `xl:` 1280
- `2xl:` 1536

Heute: alles unter `md:` ist Mobile, ab `md:` ist "Desktop". Das ist
zu binär. Neue Konvention:

- `< md` (< 768): Mobile, single-column, BottomNav
- `md:` bis `xl:` (768–1280): **Tablet**, side-rail nav, split-views
- `≥ xl` (1280+): Desktop, full TopNav, max-w constraints, hover-
  optimiert

### Neue CSS-Variablen (für Einheitlichkeit)

```css
:root {
  --side-rail-width: 72px;       /* Tablet-Nav-Rail */
  --split-left-width: 340px;     /* Liste in Split-Views */
}
@media (min-width: 768px) { /* md */
  .tablet-split { grid-template-columns: var(--split-left-width) 1fr; }
  .tablet-sidenav-padding { padding-left: var(--side-rail-width); }
}
```

### Komponenten-Änderungen (nicht erschöpfend)

- **`AppLayout`**: bei `md:` bis `xl:` zusätzlich `<SideRail />`
  rendern, `<main>` bekommt entsprechendes `pl-[var(--side-rail-width)]`.
  Der Fullscreen-`fixed inset-0 flex-col` bleibt — SideRail ist
  Position:absolute auf der Linken innerhalb des flex-col.
- **`BottomNav`**: bleibt `md:hidden`, unverändert. Side-Rail ist
  separate Komponente.
- **`SideRail`** (neu): vertikale Icons + Labels, gleiche Routes
  wie BottomNav. 72 px breit, sticky left, `bg-background border-r`.
- **Split-View-Wrapper**: neues Primitive `<SplitPane left=… right=… />`
  das per Grid rendert. Nutzung in GroupDetailPage, MealPlanPage,
  ShoppingListPage, ChatPage.
- **Detail-Page**: zwei-Spalten-Layout mit sticky-left Zutaten.

### Migration

Pro Page einzeln, low-risk weil Tailwind-responsive: 
1. SideRail + AppLayout-Umbau (einmalig, danach alle Pages profitieren).
2. GroupDetail / MealPlan / ShoppingList / Chat: Split-View-Wrapping
   an bestehenden Liste-+-Detail-Strukturen.
3. Rezept-Detail: sticky-left Zutaten (Layout-refactor).
4. Cook-Mode Landscape-Layout (wenn Cook-Now gebaut ist).

## Open Questions für User

1. **Prio**: 
   - Vollpaket als grosser eigener Phase ("Phase 5.5 Tablet")?
   - Oder inkrementell pro Page wenn sie eh angefasst wird?
2. **Zielgeräte**: iPad als primär (häufigstes Küchentablet), oder
   Android gleich stark?
3. **Side-Rail oder TopNav-Variante**: Side-Rail ist Tablet-Standard
   (iPad Apps, Spotify, Slack); TopNav wäre Desktop-Style. Empfehlung
   Side-Rail für Tablet-Zone, TopNav für Desktop-Zone.
4. **Split-View-Navigation-Modell**: React Router v7 hat "Outlet in
   Outlet" — Liste bleibt mounted, Detail switcht im Outlet.
   Alternative: Parallel-routes (Experimentell). Empfehlung:
   stacked-Outlet, supported in current stack.
5. **Hover-States**: auf Tablet gibt's Touch UND gelegentlich
   Bluetooth-Maus. `@media (hover: hover)` für Hover-Affordances,
   damit Touch-User nicht in hängenden Hover-States landen.

## Umfang-Schätzung

- **Minimal-Pack**: SideRail + ein Split-View (GroupDetail) →
  ~2 Slices.
- **Standard-Pack**: SideRail + Split auf 3 Pages (GroupDetail +
  MealPlan + Shopping) → ~4 Slices.
- **Voll-Pack**: + Rezept-Detail zwei-Spaltig + Cook-Mode-Landscape
  → ~6 Slices.

## Abgrenzung

- **Kein Desktop-Rewrite**: Hover-interaktionen, Kontextmenüs,
  Shortcut-Keys usw. sind ein anderes Scope.
- **Kein Responsive-Redesign der Mobile-Ansicht**: mobile bleibt
  unverändert, Tablet ist additive.
- **Keine iOS-native App**: PWA-only, keine SwiftUI-Portierung.
