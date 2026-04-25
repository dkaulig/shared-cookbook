# Recipe Components — sub-recipe grouping (COMP)

**Date:** 2026-04-21
**Status:** ✅ Designed via brainstorm, ready to dispatch
**Bundle tag:** `v0.10.0` after all three slices merge.

## Why

User report: a FB-reel recipe (Honey Chipotle Chicken Quesadillas +
Chipotle Sauce) has two sub-recipes in the caption, but today's data
model flattens everything into one linear ingredient list. After the
import the user can't tell which ingredients belong to the sauce vs.
the main dish. Captions on Facebook / Instagram / TikTok reels
frequently use headers like "Ingredients (Sauce):" so the structure is
mechanically detectable.

## All decisions

| # | Question | Pick |
|---|----------|------|
| 1 | Direction | **A** — structural solution, first-class grouping. |
| 2 | Scope | **A** — symmetric: components group both ingredients AND steps. |
| 3 | Data shape | **B** — separate `RecipeComponent` entity, FK from Ingredient + RecipeStep. |
| 4 | Extractor heuristic | **A** — LLM emits nested `components: [{label, ingredients, steps}]`. |
| 5 | Un-grouped ingredients | **A** — `ComponentId` required. Every recipe has ≥1 component (default with `label=null`). |
| 6 | Form UX | **A** — progressive disclosure: single-default looks like today, multi-component renders sections. |
| 7 | Reimport | **A** — replace everything (same rule as today: Photos + Custom-Tags preserved, structure wiped). |
| 8 | Delivery | **C** — COMP-0 backend + COMP-1 extractor parallel, COMP-2 frontend after. |

Locked autonomously (user delegated):
- `RecipeStep.ComponentId` also required (symmetric to Ingredient).
- Portion scaling applies uniformly to all components (v1). Per-
  component scaling deferred.
- Cook-Now mise-en-place groups by component with sticky sub-headers.
- Detail page renders component header only when `>1 component` OR
  `label != null` — single-default recipes look identical to today.
- Migration backfills every existing recipe with 1 default component
  (`label=null`, `position=0`). Existing ingredients + steps get that
  component's id.

## Domain model

**New entity:** `RecipeComponent`
- `Id: Guid`
- `RecipeId: Guid` (FK cascade delete from Recipe)
- `Position: int` (0-based, unique per recipe)
- `Label: string?` (null = default / unlabeled; non-null = user- or
  LLM-supplied name like "Chipotle Sauce")
- `CreatedAt`, `UpdatedAt` (Audit fields; optional — inherit from Recipe)

**Change:** `Ingredient` gains `ComponentId: Guid` (required, FK).
**Change:** `RecipeStep` gains `ComponentId: Guid` (required, FK).

Invariants:
- Recipe has ≥ 1 RecipeComponent (enforced on create).
- Every Ingredient.ComponentId must reference a component whose
  RecipeId matches the ingredient's RecipeId (FK + check).
- Same for RecipeStep.
- `Position` unique within `(RecipeId)` on RecipeComponent.

## Backend API shape

**Request DTOs** (`CreateRecipeRequest` / `UpdateRecipeRequest`)
extend with:

```csharp
public record RecipeComponentRequest(
    int Position,
    string? Label,
    IngredientRequest[] Ingredients,
    StepRequest[] Steps);

public record CreateRecipeRequest(
    // ... existing fields ...
    RecipeComponentRequest[] Components,
    // ... existing fields like TagIds, StagedPhotoIds ...
);
```

The flat `Ingredients` + `Steps` arrays on the request are **replaced**
by the components-nested shape. Old clients break on create/update —
per the "no deprecation shims" rule we hard-delete the flat shape.

**Response DTOs** similarly expose `components: [...]` nested.

### Backward-compat for existing clients

None — single-user app. Frontend and backend deploy together.

## Python extractor

**Schema change** (`recipe_extraction.py`):

```python
RECIPE_SCHEMA = {
  "properties": {
    # ... existing fields: title, description, servings, ... ...
    "components": {
      "type": "array",
      "minItems": 1,   # always ≥1; simple recipes get one default
      "items": {
        "properties": {
          "label": {"type": ["string", "null"]},
          "position": {"type": "integer", "minimum": 0},
          "ingredients": { ... existing ingredient shape ... },
          "steps": { ... existing step shape ... },
        },
        "required": ["label", "position", "ingredients", "steps"],
      },
    },
  },
}
```

Top-level `ingredients` and `steps` keys are **removed** from the
schema (no more flat outputs).

**System prompt delta:**

> "Falls die Quelle sichtbar mehrere Rezept-Blöcke hat (z.B. 'Ingredients
> (Sauce)' oder 'For the Main:'), zerlege das Rezept in mehrere
> `components` mit dem jeweiligen `label`. Andernfalls gib genau eine
> Komponente mit `label: null` zurück, die alle Zutaten und Schritte
> enthält."

**Post-process:**

- Normalize component order by emitted `position` (0-based, no gaps).
- Each component gets its own normalized ingredients (same rules as
  today) + normalized steps.
- `recipe_empty` fires when ALL components have 0 ingredients AND 0
  steps. Signals (`had_caption_url` / `had_blog_source` /
  `had_transcript`) continue to live at the result level.

## Frontend

### Form — progressive disclosure

Default view (`components.length === 1 && components[0].label === null`):
- Render like today: flat ingredients list + flat steps list. No
  component UI visible.
- User clicks **"+ Komponente hinzufügen"** (new button next to the
  ingredients header) → form mutates to multi-component mode.

Multi-component view:
- Each component is a `<Card>` with:
  - Editable header: input for `label`, drag-handle for reorder,
    delete-button (disabled if it's the last one).
  - Ingredient list (dnd-kit sortable, as today, but scoped to this
    component).
  - Steps list (as today, scoped).
- **"+ Komponente hinzufügen"** button at the bottom appends a new
  empty component.
- dnd-kit allows cross-component drag-drop (Ingredient moves between
  components).

### Detail page

If the recipe has `components.length === 1 && components[0].label ===
null`: render as today (no component headers, single ingredient list,
single steps list).

Else: render each component as its own section with `<h2>{label}</h2>`
header (or "Hauptgericht" as fallback when label is null in a
multi-component recipe), followed by its ingredients + steps.

### Cook-Now — mise-en-place pane

Left pane (mise-en-place) groups ingredients by component: sticky
sub-header per component, then the component's ingredients, then
next sub-header. Portion slider scales all ingredients uniformly.

### Import prefill

`ImportPrefill` DTO extended with `components` array. `extracted
ResultToPrefill` flattens from the python wire shape (which already
matches) to the form's in-memory shape.

## Reimport

`ExtractRecipeFromUrlJob.ApplyReimportAsync` gains component handling:
- Delete all existing RecipeComponents + their ingredients + steps
  (cascade).
- Insert the fresh components from the new extraction.
- Photos + Custom-Tags remain preserved (as today).
- Thumbnail auto-attach continues to work (BUG-048 promotion).

## Migration

EF-Core migration `AddRecipeComponents`:
- Create `RecipeComponents` table.
- Add `ComponentId` column to `Ingredients` (nullable initially, then
  filled, then set NOT NULL).
- Add `ComponentId` column to `RecipeSteps` (same).
- Backfill per recipe: `INSERT INTO RecipeComponents (RecipeId, Position,
  Label) VALUES (@recipeId, 0, NULL)` for every existing Recipe. Then
  `UPDATE Ingredients SET ComponentId = <new-default-id> WHERE RecipeId
  = @recipeId`, same for RecipeSteps. Finally ALTER columns NOT NULL.

Migration runs in one transaction. Non-destructive.

## TDD per layer

### Backend (COMP-0)
- Domain tests for `Recipe.AddComponent` / `Recipe.ReplaceComponents`
  / invariants (≥1 component, unique positions).
- Migration test (seed pre-component DB, apply migration, assert
  backfill).
- Endpoint tests: create recipe with nested components, update
  replaces components, reimport replaces components.
- 409 conflict test for concurrent component edits (Version header).

### Extractor (COMP-1)
- Prompt golden test: fixture of Quesadilla caption → 2 components
  with correct labels + ingredient splits.
- Single-component fallback test: plain recipe caption → 1 component
  with `label=null`.
- Post-process test: nested LLM output → normalised result with
  stable ordering.

### Frontend (COMP-2)
- `RecipeFormPage.test.tsx`: progressive-disclosure toggle (simple →
  multi-component on "+ Komponente" click); dnd-kit cross-component
  drag; label edit; delete component (disabled at 1); new recipe
  create posts nested shape.
- `RecipeDetailPage.test.tsx`: 1-default recipe renders flat,
  multi-component recipe renders with headers.
- `CookModePage.test.tsx`: mise-en-place pane groups by component.
- `importPrefill.test.ts`: nested wire shape → prefill shape.
- E2E: one spec that imports the Quesadilla URL, asserts 2
  components appear on the detail page.

## Delivery

**Round 1 (parallel, file-disjoint):**
- **COMP-0 Backend** — migration, domain, DTOs, endpoints, reimport,
  domain + endpoint tests.
- **COMP-1 Extractor** — schema, prompt, post_process, job-level
  parse, python + .NET job tests.

**Round 2:**
- **COMP-2 Frontend** — form, detail, Cook-Now, import-prefill,
  shared DTO types, web tests + E2E.

**Bundle tag:** `v0.10.0` after COMP-2 merges + full quality gates
green.

## Scope cuts

- Per-component portion scaling — v1 scales everything together.
- Sub-recipe as separate-Recipe linking (User's Frage-1 option C) —
  separate future feature.
- Component metadata beyond `Label` (color chip, icon, scalable flag)
  — future, schema already flexible via new columns.
