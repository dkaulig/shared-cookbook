# Feature Draft — Rezept-Reimport

**Date:** 2026-04-21
**Status:** 💡 Idea — wartet auf Scope-Entscheidung
**Use-case-Ursprung:** User-Brainstorm 2026-04-21: "wir haben zu den
importierten rezepten ja die urls gespeichert, wenn man auf nem rezept
dann nen button oder ne option im drei punkte menü reimport um den
import nochmal neu laufen zu lassen der das aktuelle rezept dann
updated bzw überschreiben kann"

## Pitch

Importierte Rezepte speichern ihre `sourceUrl`. Wenn der Extractor
später verbessert wird (z.B. BUG-022 description-dedupe, BUG-030
metric conversion, zukünftige Prompt-Tightenings), bleiben die alten
Imports in ihrem ursprünglichen Zustand. **Reimport** lässt den User
einen Import per One-Tap neu ausführen und das bestehende Rezept mit
dem frischen Ergebnis überschreiben.

Zusätzlicher Use-Case: Blog-Autor hat das Rezept seitdem editiert
(neue Menge, korrigierter Schritt). Reimport zieht die aktuelle
Version ohne dass der User manuell alles abgleicht.

## User-Flow

1. **Entry**: Drei-Punkte-Menü auf `RecipeDetailPage`. Neuer
   Menu-Item "Reimport", **nur sichtbar** wenn:
   - `recipe.sourceUrl` ist non-null (d.h. importiert, nicht manuell
     angelegt).
   - User hat Edit-Rechte auf das Rezept (gleiche Regel wie
     "Bearbeiten"-Option).

2. **Confirm-Dialog**: "Aktuelle Rezept-Daten werden durch einen
   frischen Import ersetzt. Manuelle Änderungen (Titel, Zutaten,
   Schritte) gehen verloren. Fortfahren?" + Buttons "Abbrechen" /
   "Reimport starten".
   - Mini-Hint zu PRESERVIERTEN Daten: *"Fotos, Bewertungen und
     'Zuletzt gekocht'-Historie bleiben erhalten."*

3. **Reimport läuft**: gleicher `ImportProgressPage`-Flow wie normaler
   URL-Import — Phase-Anzeige, Heartbeat, Timer. User kann navigieren,
   polling/SignalR hält State.

4. **Result-Handoff**:
   - **MVP**: nach "Done" navigiert User automatisch zurück zur
     `RecipeDetailPage`, die via cache-invalidate die frischen Daten
     rendert. Keine Diff-Review — der Import überschreibt direkt.
   - **Vollversion (optional)**: `ReimportDiffPage` zeigt Side-by-
     Side-Diff (Alt | Neu) pro Feld; User wählt pro Zutat / Schritt
     / Titel ob übernommen wird.

## Scope-Varianten

### MVP ("Direkt-Überschreiben")

~2 Slices.

- **REIMPORT-0** Backend:
  - Neue Route `POST /api/recipes/{id}/reimport` — req body leer
    (URL kommt vom bestehenden Recipe). Re-enqueued Hangfire-Job
    genau wie bei POST /api/recipes/import/url, aber mit einer neuen
    `targetRecipeId`-Spalte auf RecipeImport.
  - `ExtractRecipeFromUrlJob` bekommt eine neue Verzweigung: wenn
    `targetRecipeId` gesetzt ist, wird nach Azure-Response der
    bestehende Recipe-Row **in-place updated** (`UpdateFromImport`
    domain-Methode auf der Recipe-Entity) statt als neue Row
    inserted.
  - Preserve-on-update: `Id`, `GroupId`, `CreatedAt`,
    `CreatedByUserId`, `Photos`, `Ratings`, `LastCookedAt`,
    `TimesCooked`, `SlotAssignments`.
  - Overwrite-on-update: `Title`, `Description`, `Ingredients` (mit
    Cascade-Delete der alten Rows), `Steps`, `DefaultServings`,
    `PrepTimeMinutes`, `CookTimeMinutes`, `Difficulty`,
    `NutritionEstimate`, `Tags` (nur die AI-generierten behalten,
    keine manuell vergebenen Custom-Tags überschreiben — subtle!).
  - Ver­sion-Bump: `BumpVersion()` nach Overwrite (OFF3-Konsistenz).
  - ETag-Check: Request muss `If-Match: W/"{id}-{version}"` carry
    sonst 409 (Verhindert Überschreibung wenn der User parallel
    editiert hat).

- **REIMPORT-1** Frontend:
  - Drei-Punkte-Menü-Eintrag "Reimport" auf `RecipeDetailPage`.
  - Confirm-Dialog.
  - Mutation-Hook `useReimportRecipe` → POST
    `/api/recipes/{id}/reimport` → returns `{ importId }`.
  - Nach 202: navigate zur existing `ImportProgressPage` mit einem
    kleinen "Reimport läuft — Rezept wird aktualisiert"-Banner.
  - Bei Done: ImportProgressPage erkennt den Reimport-Modus am
    `targetRecipeId`-Feld im status und navigiert DIREKT zur
    `RecipeDetailPage` (nicht zum Rezept-Form wie bei
    Neu-Imports). TanStack Query invalidate auf Recipe-Cache →
    Detail re-renders mit frischen Daten.

### Vollversion ("Diff-Picker")

+1 Slice zum MVP.

- **REIMPORT-2** Diff-UI:
  - Nach Reimport-Done: neue Route
    `/groups/:gid/recipes/:rid/reimport-diff/:importId`.
  - Drei-Spalten-Layout: "Bleibt" (unveränderte Felder), "Ersetzen"
    (was der Extractor gebracht hat — checkbox pro Feld),
    "Zusammenfügen" (für Zutaten: add / merge / replace pro Row).
  - Buttons "Alle ersetzen" (= MVP-Verhalten) / "Meine Auswahl
    anwenden" / "Abbrechen".
  - Backend-seitig: `POST /api/recipes/{id}/reimport/apply` mit
    Body `{ importId, fields: string[], ingredientStrategy: 'replace'|'merge' }`.

## Technische Skizze

### Domain-Logic Änderungen

- `Recipe`-Entity: neue Methode
  ```csharp
  public void UpdateFromImport(
      string title,
      string? description,
      int? servings,
      int? prepMinutes,
      int? cookMinutes,
      int? difficulty,
      IReadOnlyList<Ingredient> newIngredients,
      IReadOnlyList<Step> newSteps,
      IReadOnlyList<string> newTagNames,
      NutritionEstimate? nutrition,
      IClock clock)
  ```
  - Replace-semantics für alles was reingegeben wird.
  - BumpVersion() am Ende.
  - Keine Änderung an Photos/Ratings/CookHistory.
  - Custom-Tags (nicht-AI) bleiben erhalten (merge-rule: existing
    custom tags ∪ new AI-tags).

- `RecipeImport`-Entity: neue Spalte `TargetRecipeId: Guid?`. EF-
  Migration `AddReimportTargetRecipeId`.

### Extractor-Job Änderungen

- `ExtractRecipeFromUrlJob.MarkDone(…)` — wenn
  `import.TargetRecipeId is not null`:
  1. Load target recipe mit `Include(r => r.Ingredients).Include(r => r.Steps).Include(r => r.RecipeTags)`.
  2. Parse ExtractionResult (same as today).
  3. `recipe.UpdateFromImport(…)`.
  4. SaveChangesAsync.
  5. Status=Done, Result-JSON enthält targetRecipeId für Frontend-
     Dispatch.
  - Sonst: heutige Flow (neue Recipe-Row erstellen über
    PF1-promote-flow).

### Frontend-Flow

- Neuer `ReimportMenuItem` component im RecipeActionBar-Drei-Punkte-
  Menü, gated auf `recipe.sourceUrl != null && can edit`.
- `ConfirmDialog` mit Warn-Copy.
- `useReimportRecipe(recipeId)` mutation.
- Navigate zu `/rezepte/import/{importId}` mit `{ mode: 'reimport',
  targetRecipeId: recipeId }` als location state.
- ImportProgressPage erkennt den Mode und passt auf Done:
  ```
  if (result.targetRecipeId) navigate(`/groups/${groupId}/recipes/${result.targetRecipeId}`)
  else navigate(`/groups/${groupId}/recipes/new?importId=${importId}`)
  ```

## Edge Cases

1. **User hat seit Import manuell editiert** — manuelle Changes gehen
   verloren (MVP). Confirm-Dialog warnt. Falls das nervig ist → Diff-
   Picker (Vollversion).

2. **URL nicht mehr erreichbar** — 404 / removed post / expired
   share. Extractor wirft den gleichen Error wie beim Initial-Import.
   Status=Error, ProgressPage zeigt Error-Banner. Rezept bleibt
   UNTOUCHED.

3. **URL liefert jetzt ein ANDERES Rezept** — Share-Link recycled für
   neues Rezept. User sieht den Diff (Vollversion) oder bekommt ein
   komplett anderes Rezept (MVP). Confirm-Dialog-Copy warnt: *"Falls
   der Link zwischenzeitlich geändert wurde, kann ein komplett
   anderes Rezept entstehen."*

4. **Race: User löscht Rezept während Reimport läuft** — Job läuft
   weiter, am Ende versucht er `recipes.Find(id)` → null →
   Status=Error mit `recipe_deleted`-Code. Keine Phantom-Create.

5. **Race: User editiert Rezept während Reimport läuft** (z.B. ändert
   Titel parallel). ETag-Check am Ende des Jobs: Recipe's aktuelle
   Version ≠ Version-zum-Job-Start → Status=Error `version_mismatch`.
   UI zeigt Hinweis + "Trotzdem überschreiben?"-Retry-Button.

6. **Reimport eines Foto-Imports?** — `sourceUrl` ist für
   Foto-Imports der `photos://upload`-Sentinel (siehe
   `PHOTO_SOURCE_SENTINEL`). Reimport-Button muss ausgeblendet
   bleiben: `sourceUrl != null && !isPhotoImportSource(sourceUrl)`.

## Test-Strategie

- **Backend Domain**: UpdateFromImport-Tests (preserve: photos,
  ratings, cooked-history; overwrite: title, desc, ingredients,
  steps; merge: custom-tags bleiben).
- **Backend Integration**: POST /api/recipes/{id}/reimport mit
  various states (happy, 404 URL, 409 If-Match-mismatch,
  already-deleted recipe, foto-sentinel rejects).
- **Job**: ExtractRecipeFromUrlJob mit TargetRecipeId-branch.
- **Frontend Component**: Drei-Punkte-Menü rendert Reimport-Item
  nur bei sourceUrl+edit-right; Confirm-Dialog; mutation fires.
- **Frontend Integration**: full happy flow Detail → Reimport →
  ProgressPage → back to Detail with fresh data. Error-Banner path.
- **Grep-Gate**: Foto-Sentinel-URL triggert keinen Reimport-Button.

## Offene Entscheidungen für User

1. **Scope**: MVP (direkt überschreiben) oder Vollversion (Diff-
   Picker)? **Empfehlung: MVP**. Diff-Picker ist hohes UI-Gewicht
   für seltenen Use-Case. Falls nötig, kann man später nachziehen.
2. **Reihenfolge**: als eigener Slice vor Phase 4 / Teil von Phase 4 /
   nach Cook-Now?
3. **Custom-Tags beim Reimport**: bleiben erhalten (ja) ODER
   überschrieben (nein)? **Empfehlung: bleiben erhalten** — User hat
   sie manuell vergeben, soll nicht durch Reimport verlieren.
4. **Photos beim Reimport**: bleiben? Oder wenn der Extractor ein
   neues Thumbnail findet, wird das zusätzlich angehängt (BUG-018-
   Style)? **Empfehlung: bleiben, neues Thumbnail wird hinzugefügt**
   wenn noch kein Foto mit gleicher URL da ist — dedupe auf URL.

## Umfang

- MVP Backend (REIMPORT-0): ~1 Slice.
- MVP Frontend (REIMPORT-1): ~1 Slice.
- Vollversion Diff (REIMPORT-2): +1 Slice.
- **Total MVP: 2 Slices**, **Vollversion: 3 Slices**.
