# Meal-plan slot UX completion — recipe title, cross-cell drag, open-recipe link

**Date:** 2026-04-26
**Status:** active
**Driver:** post-v0.14.2 the meal-plan can finally accept slots, and three
UX gaps surface immediately on first use:

1. The slot card renders the literal string `Rezept` when a recipe is
   linked but the user did not provide a free-text label. The recipe's
   title is never resolved client-side.
2. The drag-handle reorders within a single `(date, meal)` bucket but
   cannot move slots between buckets. Cross-cell drag was deferred to
   `P3-10` when meal-planning shipped, but with the wire-format fix
   landed it is now the obvious next thing the user reaches for.
3. The slot card has no affordance to navigate to the linked recipe —
   tap opens the edit dialog. `MealPlanSlotDetailPage` exists with a
   `Rezept öffnen` link but is unreachable from the week-grid.

This doc locks the design for fixing all three in one bundled v0.15.0
release. Bug 1 + Bug 3 are small. Bug 2 is the architectural piece.

---

## Decisions

### Drop semantics on cross-cell drag — between-slot insertion

When the user drops onto a target cell that already has slots, the
dropped slot lands at the **exact position** the drag indicator showed
during hover (iOS-Mail-style). Empty cells get a single drop zone.

Alternative considered: append-only ("always lands at the end"). User
explicitly picked the between-slot variant; mobile users want the
positional control because most cells will have 1-3 sibling slots
anyway and reordering after-the-fact via a second drag is two
gestures.

### DndContext scope — page-level

A single `DndContext` wraps the entire week grid (mobile day-stack
*and* desktop 7-column grid; both render through `SortableMealRow`).
Each cell stays a `SortableContext` so within-cell reorder semantics
(today's `arrayMove`) survive. Cross-cell collision detection uses
`closestCenter`, which dnd-kit ships out of the box.

Why not many DndContexts (one per cell, today's pattern): the item-id
space has to be global so a Mittag slot's id can be `over` a Dienstag-
Abend cell. Page-level is the simplest way to get there without
introducing a custom collision algorithm.

### Drop-zone visualisation — empty cell + line indicator

- **Empty cells** render a tinted placeholder (current `Noch keine
  Gerichte für diesen Tag` button stays — it doubles as a drop
  surface during drag, with `bg-primary/5` tint when `over.id ===
  cell-id`).
- **Cells with slots** rely on dnd-kit's existing transform animations
  for the displaced sibling, plus a 2-px primary-tinted bar between
  slots indicating the drop position. The bar renders as an empty
  `<li>` in the SortableContext that becomes visible only while the
  drag is active.

### Mobile auto-scroll — enabled

`@dnd-kit/core` ships an `autoScroll` config that scrolls the
nearest scroll-ancestor when the pointer is near a viewport edge.
Enable it (default thresholds are reasonable). Without auto-scroll
the iPhone day-stack is unusable for long drags because the user
can only reach the next day by scrolling.

### Optimistic update — same pattern as today

`usePatchSlot` already does optimistic via cache splice. Cross-cell
move is one PATCH (date + meal + sortOrder); the optimistic update
reads the cached plan, splices the slot out of its old bucket and
into the new one at the dropped sortOrder, and rolls back on
PATCH failure (existing OFF4 conflict path).

### BE schema — extend SlotPatchRequest with `date` + `meal`

Today's PATCH covers servings/sortOrder/isCooked/parentSlotId/recipe/
label. Adding `date` (string ISO) and `meal` (string enum) lets one
PATCH express the cross-cell move atomically. JSON Merge Patch
semantics still hold: an absent field leaves the slot untouched.

Domain side: `MealPlanSlot` gets a `MoveTo(DateOnly date, MealSlot
meal, int sortOrder, DateTimeOffset at)` method that validates the
new date stays in `[WeekStart, WeekStart+6]` and bumps `UpdatedAt`.
The endpoint catches the same `ArgumentException` family as the
existing AddSlot guards and maps to 400 + fieldName.

### DTO enrichment — `recipeTitle` on `MealPlanSlotDto`

Adding `RecipeTitle` (nullable string) to the DTO is one EF Core
include + a `ToDto` parameter change. Cheaper than a per-page
batch-fetch on the FE side and stays in sync automatically when
recipes get renamed (no FE cache invalidation across feature
boundaries).

The wire shape becomes:
```json
{ "id": "...", "recipeId": "...", "recipeTitle": "Pasta Bolognese",
  "label": null, "date": "2026-04-22", "meal": "Mittag", ... }
```

`recipeTitle` is `null` when:
- no recipe is linked (`recipeId === null`); OR
- the recipe was soft-deleted (joined row gone) — FE rendering
  treats this same as the no-recipe case.

### Open-recipe affordance — small icon button on the slot card

Place an `ExternalLink` lucide icon as a 28-px button between the
title block and the 3-dot overflow menu. Renders only when
`slot.recipeId !== null`. Clicking navigates to
`/groups/<groupId>/recipes/<slot.recipeId>` via React Router's
`useNavigate`. `groupId` is plumbed down from `MealPlanPage` →
`SortableMealRow` → `SortableSlotCard` (one new prop).

The card body itself stays click-to-edit (consistent with current
behaviour); the icon is the explicit "navigate" path. We avoid making
the title a link because that would conflict with the
edit-dialog-on-tap UX users already learned in the existing slice.

---

## Implementation order

1. **BE — recipeTitle on DTO.** RED→GREEN: assert wire shape contains
   the title for an enriched slot; happy path tests already cover the
   unrelated paths.
2. **BE — PATCH date + meal.** RED→GREEN: cross-cell PATCH, asserts
   updated bucket. Domain `MoveTo` test for invariant.
3. **Shared TS types.** Extend `MealPlanSlotDto` + `PatchSlotRequest`.
4. **FE — Bug 1 + Bug 3 (one commit).** Title rendering, open-recipe
   icon; small unit test for the title fallback chain.
5. **FE — Bug 2 (one commit).** DndContext refactor, drop-indicator
   line, optimistic cache splice for cross-cell move. Tests cover:
   same-cell reorder still works, cross-cell move calls PATCH with
   new date/meal/sortOrder, optimistic update splices correctly,
   PATCH 409 rolls back.
6. **4-stage flow.** /simplify + /security inline; full Python four-
   gate + .NET + web suites; tag `v0.15.0` (minor bump — new feature
   surface) with GitHub Release per CLAUDE.md rule.

---

## Out of scope

- Multi-select drag (move 2+ slots at once) — keep one-slot-at-a-time
  for v1.
- Drag from one week into the next — week navigation is a separate
  view; we do not support it.
- Touch-and-hold preview à la iOS Mail's deep-press — `delay: 200`
  activation is good enough.
- ParentSlotId rewiring on cross-cell move — the parent reference
  survives moves; if the parent gets stranded in a cell that no
  longer makes semantic sense, the user fixes it via the existing
  `EditSlotDialog`. Auto-detaching would surprise more than it
  helps.
