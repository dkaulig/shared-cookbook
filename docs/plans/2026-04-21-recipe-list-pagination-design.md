# Server-side Pagination for Recipe Lists

**Date:** 2026-04-21
**Status:** ✅ Design validated, ready to implement
**Follows:** v0.9.2 (Cook-Now + Reimport + Tablet)
**Leads to:** Cross-Group-Search slice (same bundle tag `v0.9.3`)

## Why

`GET /api/groups/{groupId}/recipes` currently returns the full group
slice in one response. At ~500+ recipes per group the mobile list
slows to a crawl and the payload bloats the offline cache. The user
also flagged the cross-group "I know we cooked it, can't remember the
group" pain point — pagination lays the groundwork.

## Scope

**In:**
- Pagination of the existing group-recipes endpoint.
- URL-driven page + sort state on `GroupDetailPage`.
- `shadcn/ui` `<Pagination />` UI.
- Composite DB indexes for each supported sort key.
- Backward-compat defaults so old clients don't break.

**Out (later slice, same bundle tag):**
- Cross-group recipe search — new `/api/recipes/search` endpoint + UI.
- Tag-filter.
- Infinite-scroll or desktop-alternative UI.

## Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Scope ordering | **B** — pagination first, search second, one tag at the end. |
| 2 | API schema | **C** — offset-style API (`?page=N&pageSize=M`), keyset internally where it pays off. |
| 3 | UX shape | **B** — numbered pages; `totalCount` in response (no infinite-scroll). |
| 4 | Sort options | **C** — full menu: `updated_desc` / `cooked_desc` / `title_asc` / `cook_count_desc` / `rating_desc`. |
| 5 | Offline cache | **A** — cache-per-page (each `(page, sort)` is its own TanStack-Query key). |
| 6 | Page size | **C** — default `24` (grid-friendly), server clamps 1–100. |

## Backend

### Endpoint

```
GET /api/groups/{groupId}/recipes?page=1&pageSize=24&sort=updated_desc
```

- `page` int ≥ 1, default 1.
- `pageSize` int, default 24, clamped 1–100.
- `sort` enum, default `updated_desc`:
  - `updated_desc` — `UpdatedAt DESC`.
  - `cooked_desc` — `LastCookedAt DESC NULLS LAST`.
  - `title_asc` — `Title ASC`.
  - `cook_count_desc` — cook-count DESC. **Gated on field availability** (check during impl: if a `TimesCooked` column or equivalent aggregate exists, ship; else cut with TODO).
  - `rating_desc` — `AvgRating DESC NULLS LAST`.
- Tie-breaker always `Id ASC`.

### Response shape

```json
{
  "items": [...],
  "page": 1,
  "pageSize": 24,
  "total": 287,
  "hasNextPage": true,
  "hasPrevPage": false
}
```

`total` = `SELECT COUNT(*) FROM "Recipes" WHERE "GroupId" = ? AND "DeletedAt" IS NULL`. Sub-ms for realistic family-cookbook sizes (≤ 500 recipes/group).

### Validation + errors

- `page < 1` → 400 with `ErrorResponse { code: "invalid_page" }`.
- `pageSize < 1 || > 100` → 400 with `invalid_page_size`.
- Unknown `sort` → 400 with `invalid_sort`.
- Deep-link `?page=99` on a 3-page list → empty `items: []` + honest `total`, `hasNextPage: false`. **No 404, no redirect** — deep-links must not crash.

### Indexes

Composite indexes on `Recipes` (all with `WHERE "DeletedAt" IS NULL`):

```sql
CREATE INDEX ix_recipes_group_updated
  ON "Recipes" ("GroupId", "UpdatedAt" DESC, "Id")
  WHERE "DeletedAt" IS NULL;

CREATE INDEX ix_recipes_group_title
  ON "Recipes" ("GroupId", "Title", "Id")
  WHERE "DeletedAt" IS NULL;

CREATE INDEX ix_recipes_group_cooked
  ON "Recipes" ("GroupId", "LastCookedAt" DESC NULLS LAST, "Id")
  WHERE "DeletedAt" IS NULL;
```

Rating + cook-count indexes decided during impl based on column
availability.

Migration: `AddRecipesListPaginationIndexes`. Indexes only — no schema
change.

### Backward-compat

Old clients without query params → page 1, default 24, default sort.
No breaking change.

## Frontend

### Hook

`useRecipes(groupId, { page, pageSize, sort })`. Query key:
`['recipes', groupId, page, sort]`. `pageSize` folded into the key only
when non-default.

### URL as state

React-Router `useSearchParams` for `page` + `sort`. Sort-change resets
`page` to `1`. Deep-linkable.

### Pagination UI

`shadcn/ui` `<Pagination />` primitive. Desktop/tablet: numbered
`← Zurück 1 2 3 … 12 Weiter →`. Mobile: compact `← 3 / 12 →`.

### Sort control

`<Select>` in `GroupDetailPage` header (or the TABLET-1 split-view's
left-pane header). 5 German labels: "Zuletzt aktualisiert", "Zuletzt
gekocht", "Titel A-Z", "Am häufigsten gekocht", "Beste Bewertung".

### SplitPane integration

Recipe list sits in the left slot of `<SplitPane>` at `md:+`.
Pagination nav stickies at the bottom of the left column's scroll
container. Mobile: pagination under the card list.

### Loading / empty / offline

- `isPending` → 24 skeleton cards.
- `isFetching` on page-change → subtle progress bar.
- `items.length === 0 && page > 1` → `<EmptyState>` with "Zur ersten
  Seite" link.
- Offline + uncached page → `<EmptyState>` with "Offline — Seite nicht
  im Cache".

## Consumer audit

Callers of the existing endpoint:

| Caller | Impact |
|--------|--------|
| `GroupDetailPage` | Full pagination UI. Primary consumer. |
| Home-page "Zuletzt gekocht" widget | `pageSize=5&sort=cooked_desc`. No UI change. |
| MealPlan slot-picker | `pageSize=100&sort=title_asc` as stopgap until Cross-Group-Search lands. |
| Fork target picker | Same stopgap as slot-picker. |

## TDD

- Backend: `ListGroupRecipesTests` extended — page bounds, pageSize
  clamp, unknown sort, each sort stable + correct order, `total`
  accurate, deep-link `page=99` returns `items=[]` + honest meta.
- Domain: no changes (Recipe entity unchanged).
- Frontend: `GroupDetailPage.test.tsx` extended — URL param drives
  page + sort, sort-change resets page, pagination nav visible,
  skeleton while loading, empty-state on deep-link-past-end.
- Hooks: `useRecipes` tests — query-key composition, cache-per-page.
- E2E (local, bot-auth): `apps/web/e2e/recipe-list-pagination.spec.ts`
  — visit group, verify 24 cards, click page 2, verify URL + distinct
  cards, change sort, verify reset-to-page-1. Credentials-gated.

## 4-stage flow

Per repo policy: impl → /simplify → /security → fix-commit → reviewer.
Dispatched as a single sub-agent.

## Rollout

- Lands on `main` without a tag.
- Cross-Group-Search slice follows; shared bundle tag `v0.9.3` triggers
  one deploy.

## Open questions (for impl)

- Cook-count column — is there a `TimesCooked` aggregate, or do we
  count from `CookHistory` on the fly? If the latter, consider a
  materialized view or just cut `cook_count_desc` from the slice.
- AvgRating — column on Recipe, or computed via `Ratings` subquery?
  If computed, document the perf ceiling.

These are impl-time decisions, not blockers.
