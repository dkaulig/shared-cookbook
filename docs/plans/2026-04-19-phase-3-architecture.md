# Phase 3 — Meal Planning · Master Architecture Plan

**Phase:** 3
**Status:** planned (user approval needed before P3-0 dispatch)
**Date:** 2026-04-19
**Depends on:** Phase 2 complete (1604 tests green) + PF1/PF2/PF3 landed.
**PRD reference:** `docs/plans/2026-04-17-familien-kochbuch-design.md` §6.

## Why a master plan

Phase 3 turns the recipe collection into an operational kitchen planner: weekly meal plan + auto-generated shopping list. Scope per PRD + user-expansion 2026-04-19:

> "super wäre beim wochenplan auch wenn man mehrere Gerichte pro Tag angeben kann mit Portionsgröße. zum beispiel Sonntag ein Gericht das ich für meal prep mach für die ganze Woche. oder falls man mittags und abends was einplanen muss oder falls man zwei verschiedene Gerichte kochen mag da man zwei Geschmäcker abdecken muss"

Three distinct use-cases the data model must support:

1. **Multi-slot pro Tag**: z.B. Mittag + Abend an einem Dienstag, zwei separate Gerichte.
2. **Parallele Geschmäcker**: z.B. Dienstag-Abend zwei Gerichte gleichzeitig, weil Partner vegan isst und Kids Schnitzel wollen — beide am selben Tag, beide Hauptgerichte, beide separate Portionen.
3. **Meal-Prep**: z.B. Sonntag 1 Gericht × 5 Portionen → vorgekocht für Mo-Fr Mittag. Die Einkaufsliste soll das Gericht **einmal** mit 5 Portionen einkaufen, nicht fünfmal.

## Data model

**Neu: flexibles Slot-Modell** statt fester Frühstück/Mittag/Abend-Enum.

```csharp
public sealed class MealPlan
{
    public Guid Id { get; private set; }
    public Guid GroupId { get; private set; }
    public DateOnly WeekStart { get; private set; } // Monday
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }
    public int Version { get; private set; } // incremented on each edit, used for optimistic concurrency + light history
}

public sealed class MealPlanSlot
{
    public Guid Id { get; private set; }
    public Guid MealPlanId { get; private set; }
    public DateOnly Date { get; private set; }
    public string Label { get; private set; } // free-text: "Mittag", "Abend", "Meal Prep", "Partner-Teller" …
    public int SortOrder { get; private set; } // 0..N within the day, UI-orderable
    public Guid RecipeId { get; private set; }
    public int Servings { get; private set; } // can override recipe default
    public Guid? ParentSlotId { get; private set; } // ← meal-prep / leftover link
    public bool IsCooked { get; private set; } // mark-as-cooked toggle
    public DateTimeOffset CreatedAt { get; private set; }
}
```

### `ParentSlotId` — der Meal-Prep-Mechanismus

- **Normaler Slot** (`ParentSlotId == null`): ein eigenständiges Gericht, wird in die Einkaufsliste gezählt.
- **Rest-/Leftover-Slot** (`ParentSlotId != null`): verweist auf einen anderen Slot (der typischerweise am gleichen oder früheren Tag liegt und höhere Portionen hat). Wird in der Einkaufsliste **nicht** gezählt, weil die Zutaten schon beim Parent-Slot eingekauft werden. Trägt trotzdem `Servings` zur Anzeige + zum Mark-as-cooked-Flow.

**Beispiel:** Sonntag Meal-Prep "Linsen-Curry" × 5 Portionen (`ParentSlotId=null`, `Label="Meal Prep"`). Mo–Do Mittag jeweils ein Slot "Linsen-Curry" × 1 Portion mit `ParentSlotId=Sonntag-Slot`. Einkaufsliste kauft 5 Portionen Linsen-Curry ein, **einmal**. UI zeigt die Rest-Slots mit einem kleinen "↺ aus Meal Prep"-Badge.

### Constraints + Invariants

- `MealPlan(GroupId, WeekStart)` unique — eine Gruppe hat pro Kalenderwoche genau einen Plan.
- `MealPlanSlot.Date` muss im `[WeekStart, WeekStart+6]`-Fenster liegen.
- `ParentSlotId` muss auf einen Slot im **selben MealPlan** zeigen.
- `ParentSlotId`-Kette darf nicht zyklisch werden (DB-Constraint + Domain-Check).
- `Label` 1..40 Zeichen, nach Trim; frei-Text, keine Enum.
- `Servings` 1..50 (großzügiger Range als Recipe.DefaultServings, weil Meal-Prep-Einträge hoch gehen können).

## Frontend-Model

### Wochenplan-Ansicht

- 7-Spalten-Grid auf Desktop (Mo bis So), vertikal gestackt auf Mobile.
- Pro Tag: beliebig viele Slots übereinander, drag-&-drop-orderable.
- Jeder Slot: Rezept-Thumbnail + Label + Portionen-Badge + (falls Parent) "↺"-Badge.
- "+ Gericht hinzufügen"-Button pro Tag öffnet einen Recipe-Picker (Modal, mit Suche + Filter ähnlich der existing Filter-Panel).
- Nach Recipe-Auswahl: Portions-Stepper (default = `Recipe.DefaultServings`) + Label-Input (default "Hauptgericht") + optional "ist Meal-Prep-Rest von …"-Dropdown (listet die anderen Slots der Woche).
- Mark-as-cooked Checkbox auf jedem Slot (auch auf Rest-Slots — Meal-Prep-Parent bleibt "nicht gekocht" bis sein letzter Rest abgehakt ist? Decision: jeder Slot unabhängig abhakbar, keine magische Ableitung).
- Wochen-Navigation: Pfeile + Datum-Anzeige ("KW 16 · 13.–19. April 2026").
- "Plan der letzten Woche kopieren"-Button.

### Einkaufsliste-Ansicht

- Erzeugung: "Einkaufsliste erzeugen"-Button im Wochenplan-Footer.
- Aggregation **nur über Non-Leftover-Slots** (ParentSlotId == null).
- Pro Zutat: Summe aller Slot-Portionen-Skalierungen. Gleiche Zutat + Einheit → summieren. Unterschiedliche Einheit → separate Zeile.
- Kategorisierung: Obst/Gemüse · Milchprodukte · Fleisch/Fisch · Trockenware · Gewürze · Backwaren · Sonstiges. Initial über eine **statische Zutaten→Kategorie-Map** (seeden wir mit ~200 häufigen deutschen Zutaten), später optional per LLM für unbekannte.
- **Sort-Toggle (user-requested 2026-04-19):** Header-Control mit zwei Modi:
  - **"Nach Kategorie"** (default): Items nach `IngredientCategory`-Enum gruppiert, innerhalb jeder Kategorie alphabetisch (Umlaut-aware via `StringComparer.InvariantCultureIgnoreCase` — "Äpfel" kommt zwischen "Apfel" und "Banane", nicht hinter "Zucker"). Kategorie-Header sichtbar.
  - **"Alphabetisch"**: flach A-Z über alle Zutaten, keine Kategorie-Header. Gut wenn man das Rezept im Kopf hat und nur nach dem Namen sucht.
  - Preference pro User persistiert in `localStorage` (nicht `sessionStorage` — survivor-across-sessions, keine sensiblen Daten).
- Live-Check-off: klicken → State serverseitig, SignalR pushed zu anderen Clients. Partner sieht ✓ sofort.
- Manuell ergänzen: "+ Zutat hinzufügen" → Text + Einheit + Menge + Kategorie.
- Manuell entfernen: X auf der Zeile.

## Sub-slice decomposition

Abhängigkeiten in Klammern.

### P3-0 — Domain + Migration

`MealPlan` + `MealPlanSlot` Entities, EF-Config, Migration `AddMealPlanning`. Domain-Invariants getestet (Unique, Date-Range, Parent-Cycle-Check, Label-Länge, Servings-Range). **Est.: 2h.**

### P3-1 — CRUD-Endpoints (Plan + Slot)

- `GET /api/groups/{id}/mealplans/{weekStart}` — holt oder 404.
- `POST /api/groups/{id}/mealplans` — legt einen neuen Plan für die Woche an (idempotent falls bereits existent).
- `POST /api/mealplans/{id}/slots` — fügt Slot hinzu.
- `PATCH /api/mealplans/{id}/slots/{slotId}` — ändert Servings / Label / SortOrder / Recipe / ParentSlotId / IsCooked.
- `DELETE /api/mealplans/{id}/slots/{slotId}` — (wenn Slot Parent ist: Kinder werden auf `ParentSlotId=null` zurückgesetzt — nicht kaskade-gelöscht, sonst verliert User Arbeit).
- `POST /api/mealplans/{id}/copy-from/{sourceWeekStart}` — Template-Kopie.

Auth: Group-Mitglied = read/write. Integration-Tests pro Endpoint. **Est.: 3h.**

### P3-2 — Wochenplan-UI (read + slot-add)

Grid-Rendering + "+ Gericht hinzufügen"-Modal + Recipe-Picker (reuse `useRecipeSearch`). Ohne Drag-&-Drop noch. **Est.: 3h.**

### P3-3 — Slot-Edit + Drag-Reorder + Delete + Mark-as-cooked

Inline-Edit-Modal, `@dnd-kit` Integration für Reorder (existing Pattern aus RecipeForm), Mark-as-cooked Toggle. **Est.: 2-3h.**

### P3-4 — Meal-Prep / Parent-Slot UX

Dropdown "ist Rest von …" bei Slot-Create + Edit; Badge-Anzeige; Parent-Deletion-Schutz. **Est.: 1-2h.**

### P3-5 — Einkaufsliste-Aggregation (Backend)

- `GET /api/mealplans/{id}/shopping-list` — generiert on-demand oder ruft gespeicherte Liste ab.
- Aggregation-Logik inkl. Leftover-Slot-Filter.
- `ShoppingList` + `ShoppingListItem` Entities (speicher den State, damit Check-offs persistent sind und nicht bei Regeneration verloren gehen).
- Migration.
- `PATCH /api/shopping-lists/{id}/items/{itemId}` — toggles IsChecked.
- `POST /api/shopping-lists/{id}/items` — manuelle Zutat hinzufügen.
- `DELETE /api/shopping-lists/{id}/items/{itemId}`.
- Regeneration-Logik: wenn User Wochenplan ändert, `POST /api/mealplans/{id}/shopping-list/regenerate` mergt neue Zutaten in die bestehende Liste (check-off-Status von bereits-abgehakten Items bleibt; neu berechnete Mengen werden upserted).

**Est.: 3-4h** (größter Slice wegen Merge-Logik).

### P3-6 — Zutaten-Kategorisierung

- `IngredientCategory` Enum.
- Statische Map (`IngredientCategorizer.cs`) mit ~200 Einträgen: "Tomate"→Obst/Gemüse, "Mehl"→Trockenware, "Basilikum"→Gewürze, etc.
- Fallback: unbekannte → "Sonstiges".
- Optional: LLM-Kategorisierung für unbekannte via P2-1 Provider (1 Extra-Call pro unbekannter Zutat, cached).

**Est.: 2h.**

### P3-7 — Einkaufsliste-UI

Kategorie-Gruppierung, Check-off-Klick, Add/Remove-Interaktionen, "Fertig"-Progress-Anzeige (N/M abgehakt). **Est.: 2-3h.**

### P3-8 — SignalR-Hub

- Long-standing v2-backlog-item wird hier realisiert, weil die Shopping-Liste ohne Live-Sync halbgar wäre.
- ASP.NET Core SignalR Hub, JWT-Auth, Group-scoped Connections.
- Events: `MealPlanSlotChanged` (create/update/delete), `ShoppingListItemChanged`, `RecipeChanged` (bonus — nicht Phase-3-Scope, aber fast kostenlos).
- Frontend: TanStack-Query-Invalidation via SignalR-Event-Listener, kein manueller Refetch nötig.
- Reconnect-on-disconnect mit exponential-backoff.

**Est.: 3-4h.**

### P3-9 — Templates + Light-History

- "Plan der letzten Woche kopieren" — clones slots into new week.
- `MealPlan.Version++` bei jedem Slot-Change; speichere Diff in `MealPlanRevision` (optional-scope, evtl. defer to Phase 4).

**Est.: 1-2h.**

### P3-10 — Mobile-Polish

Swipe-Gestures für Slot-Delete, Long-Press für Reorder, responsive Kompaktansicht. **Est.: 1-2h.**

## Dependencies-Graph

```
P3-0  ─► P3-1 ─► P3-2 ─► P3-3 ─► P3-4
                              ╲
                               ╲─► P3-5 ─► P3-6 ─► P3-7
                                              ╱
                                  P3-8 ◄─────┤
                                              ╲─► P3-9
                                                  P3-10
```

Parallelisierbar nach P3-4 landing: **P3-5/6/7** (Backend+UI Einkaufsliste) und **P3-8** (SignalR) + **P3-9/10** (Polish).

## Total scope

~22-30h Agent-Zeit auf 11 Sub-Slices. Realistisch 4-6 Tage Orchestrator-Wall-Time.

## Non-goals (explicit, per PRD §6.3)

- Keine Supermarkt-API (Rewe/Edeka).
- Keine Preis-Schätzung.
- Keine automatischen Plan-Vorschläge (Phase 4 AI).
- Kein Voice-Input beim Slot-Anlegen.
- Keine Kalorien-Aggregation pro Woche (wäre nice, aber scope-creep — kann P3-polish werden wenn die Nährwert-Estimation zuverlässig ist).

## Architectural decisions (user-confirmed 2026-04-19)

1. **ShoppingList lifecycle**: **persisted editable**. Manual additions + check-offs survive Wochenplan-edits. Regen-Logik mergt neue Zutaten rein, lässt bestehende unberührt.

2. **Ein Plan pro Gruppe pro Woche** (kein Alternativ-Plan). **Neu:** Shopping-List kann "in Gänze neu erzeugt" werden (z.B. wenn User mid-week den Plan umstellt und eine neue Einkaufsrunde plant). Der Regenerate-Flow überschreibt die alte Liste, merged unchecked items optional weiter in die neue Runde (siehe §Carryover unten).

3. **Copy-last-week**: nur Slots, keine ShoppingList-Übernahme. Shopping-List wird frisch generiert beim nächsten Open.

4. **Mark-as-cooked**: unabhängig pro Slot. Meal-Prep-Parent = "gekocht am Sonntag"; Rest-Slots = "aufgewärmt am Dienstag". Beide getrennt abhakbar.

5. **LLM-Kategorisierung**: Hybrid. Statische Map zuerst (deckt 80% ab), unbekannte → "Sonstiges" + "KI-Kategorisierung anfordern"-Button triggert on-demand LLM-Call.

6. **SignalR**: eigenständiger Sub-Slice P3-8. Wird querschnittlich gebraucht (MealPlanSlot-Changes, Shopping-Check-off, zukünftige Features).

## Carryover: offene Shopping-List-Items in die nächste Woche übernehmen

**User-Anforderung 2026-04-19:** "offene sachen die man nicht bekommen hat in neue woche übernehmen".

Use-case: User macht Samstag Einkauf, bekommt keine reifen Avocados → bleibt unchecked. Nächste Woche soll die Avocado automatisch wieder auf der Liste stehen.

**Daten-Modell-Erweiterung:**
- `ShoppingListItem` gains `CarriedOverFromPreviousWeek: bool` (default false). Purely display — zeigt ein kleines "↺ aus KW 16"-Badge auf der neuen Liste.

**Flow:**
- Beim **Generate** der ShoppingList für KW N (durch explizite User-Action oder beim ersten Open der Woche):
  1. Aggregiere Zutaten aus KW-N-Slots wie bisher.
  2. Wenn KW N-1 eine persistierte ShoppingList hat: **unchecked** + **nicht-manuell-entfernte** Items aus KW N-1 mit `CarriedOverFromPreviousWeek=true` zur neuen Liste hinzufügen (merging-by-name+unit: wenn der Slot-basierte Generator bereits eine Avocado gelistet hat, wird die Carryover-Avocado mit ihrer Menge addiert; sonst steht sie allein da).
  3. Zur Transparenz: "↺ aus letzter Woche"-Badge auf jedem Carryover-Item.
- User kann im Shopping-List-UI pro Item "nicht übernehmen" (X) wenn er das Item final aufgegeben hat.
- Carryover-Merge ist einmalig (beim Generate/Regenerate); subsequent Regenerates der gleichen Woche wiederholen den Merge nicht (sonst würde gecheckte Items die carryover-Herkunft verlieren).

**Regenerate-Flow (mid-week):**
- Button "Einkaufsliste neu erzeugen" im Shopping-List-Header.
- Dialog: "Aktuelle Häkchen beibehalten? Offene Items beibehalten?"
- Default: Häkchen behalten (für bereits gekauft), offene Items auch behalten, nur neu-hinzugekommene Slots werden hinzugefügt.

**Zusätzlicher Sub-Slice nötig:** P3-5a (Regenerate + Carryover) — entweder inline im P3-5 oder als eigener Mini-Slice. Entscheidung bei P3-5-Dispatch.

## Total scope (aktualisiert)

## Acceptance criteria (Phase 3 overall)

- Alle Sub-Slices geshipped, tests green, simplify + security-review + reviewer pass je Slice.
- End-to-end flow testbar:
  - User legt Wochenplan an → drag 5 Rezepte + 1 Meal-Prep auf 5 Tage
  - Klickt "Einkaufsliste erzeugen" → sieht Zutaten gruppiert nach Kategorie, Meal-Prep einmal aggregiert
  - Partner öffnet App parallel beim Einkauf → hakt "Tomaten" ab → User sieht das live
  - User klickt "Plan letzte Woche kopieren" → neue KW mit denselben Slots
- Performance: Wochenplan-Load < 300ms bei 30 Slots, Shopping-List-Generation < 500ms bei 200 Zutaten.
- Keine Regression in Phase-1 / 1.5 / 2 Tests (bleibt 1600+).

## Anti-shortcut reminders

- TDD pro Domain-Change und pro Endpoint.
- `/simplify` + `/security-review` + Reviewer-Pass ab P3-0 (per Mandat 2026-04-19).
- Keine Magie-Ableitungen: Mark-as-cooked bleibt explizit pro Slot.
- Leftover-Slot-Filter in Shopping-List-Aggregation muss **einen dedizierten Test** haben — sonst schleicht sich ein Double-Count ein.
- SignalR-JWT-Validation nicht schludern: Connections ohne gültiges Token müssen rejected werden, sonst data leak zwischen Gruppen.
