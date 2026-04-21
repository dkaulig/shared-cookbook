# Cross-Group Recipe Search

**Date:** 2026-04-21
**Status:** ✅ Designed autonomously per user delegation
**Follows:** PAGE-0 + PAGE-1 (pagination, same bundle)
**Tag:** `v0.9.3` at end of this slice (combined with pagination).

## Why

User quote (2026-04-21): "ich weiß wir haben's gekocht aber in welcher
gruppe?" The per-group `GroupDetailPage` search (`/api/groups/{id}/
recipes/search`) scopes to one group at a time. With 3–6 groups per
family, finding a half-remembered recipe means tab-hopping.

The TopNav already exposes a disabled `<button>` "Suche (bald
verfügbar)" (`apps/web/src/components/layout/TopNav.tsx`). This slice
activates it.

## Design decisions (all picked autonomously)

| # | Question | Pick | Rationale |
|---|----------|------|-----------|
| 1 | Endpoint shape | `GET /api/recipes/search` (top-level) | Different authz model (group-membership set vs single-group gate). Clean separation. |
| 2 | Search impl | `ILIKE '%q%'` on title + description; exact-match on tag names | YAGNI. Full-text tsvector is a later perf slice if the user ever hits 5k+ recipes. At realistic family scale (≤2000 total across all groups) `ILIKE` is sub-10 ms with the existing `GroupId` index filtering first. |
| 3 | Tag matching | Case-insensitive exact match on tag name | Simple, predictable UX. Prefix / fuzzy can come later. |
| 4 | Result shape | Flat list, each item carries `groupId` + `groupName` | Paginates naturally. UI renders with group-chip per card. |
| 5 | Authz | Scope via join to `GroupMemberships` WHERE UserId = caller | Server enforces; caller can't probe foreign groups. |
| 6 | Sort options | `relevance_desc` (default) / `updated_desc` / `cooked_desc` / `title_asc` / `rating_desc` | Mirrors PAGE-0 list-endpoint enum, adds `relevance_desc`. `cook_count_desc` still cut. |
| 7 | Relevance ranking | title-match weight 3, description-match weight 1, tag-match weight 2, sum per row | Simple, deterministic, adequate for "did I see this title?" queries. No BM25. |
| 8 | Empty `q` | 400 `invalid_query` when `q` is empty or < 1 char | Prevents accidental "dump all my recipes" — that's what the list endpoint is for. |
| 9 | Pagination | Same shape as PAGE-0 (`page`, `pageSize` default 24, `total`, `hasNextPage`, `hasPrevPage`) | Consistency. |
| 10 | Frontend entry-point | Activate the existing disabled "Suche" button in TopNav + add to SideRail + BottomNav | The UI affordance is already designed and reserved; we just wire it. |
| 11 | Route | `/suche` | German URL matches existing conventions (`/rezepte/…`, `/gruppen/…`, `/wochenplan`). |
| 12 | Offline cache | Cache-per-query (TanStack-Query key: `['recipe-search', q, sort, page]`) | Matches PAGE-0 decision; IndexedDB persistence covers warm queries. |
| 13 | Debounce | 300 ms on typing → URL `?q=…` → hook fires | Same debounce pattern as GroupDetailPage's existing in-group search. |

## Backend

### Endpoint

```
GET /api/recipes/search?q=lasagne&page=1&pageSize=24&sort=relevance_desc
→ 200 {
  items: [
    {
      id, title, description, photo, tagIds, createdByDisplayName,
      updatedAt, avgRating, ratingCount, myStars,
      groupId, groupName
    }, ...
  ],
  page, pageSize, total, hasNextPage, hasPrevPage, query: "lasagne"
}
```

Empty `q`, `q.length < 1` → 400 `invalid_query`.
Same `page` / `pageSize` / `sort` validation as PAGE-0.
Sort `relevance_desc` only applies when `q` is set (it is — empty
rejected above).

### Query shape

```sql
SELECT r.*, g."Name" AS "GroupName",
  CASE WHEN @sort = 'relevance_desc' THEN
    (CASE WHEN r."Title"        ILIKE '%'||@q||'%' THEN 3 ELSE 0 END) +
    (CASE WHEN r."Description"  ILIKE '%'||@q||'%' THEN 1 ELSE 0 END) +
    (CASE WHEN EXISTS(... tag name match on RecipeTags join ...) THEN 2 ELSE 0 END)
  ELSE 0 END AS "Score"
FROM "Recipes" r
JOIN "Groups" g ON g."Id" = r."GroupId"
JOIN "GroupMemberships" gm ON gm."GroupId" = g."Id" AND gm."UserId" = @caller
WHERE r."DeletedAt" IS NULL
  AND (
    r."Title" ILIKE '%'||@q||'%'
    OR r."Description" ILIKE '%'||@q||'%'
    OR EXISTS (SELECT 1 FROM "RecipeTags" rt JOIN "Tags" t ON t."Id" = rt."TagId"
               WHERE rt."RecipeId" = r."Id" AND t."Name" ILIKE '%'||@q||'%')
  )
ORDER BY
  CASE WHEN @sort = 'relevance_desc' THEN "Score" END DESC,
  -- sort-specific ORDER BY clauses here
  r."Id" ASC
LIMIT @pageSize OFFSET @skip;
```

Implementation via EF LINQ — the equivalent expression tree, not raw
SQL. Postgres translates `ILIKE` as `ILIKE`; tests use in-memory
fallback (SQLite) with `EF.Functions.Like` and case-insensitive compare.

### Validation

- `q` required, trimmed, length 1–200 → 400 `invalid_query` otherwise.
- `page` ≥ 1 → 400 `invalid_page`.
- `pageSize` 1–100 → 400 `invalid_page_size`.
- Unknown `sort` → 400 `invalid_sort`.

### Indexes

No new indexes in this slice. The existing `(GroupId, UpdatedAt DESC, Id)`
composite (from PAGE-0) is used for the post-filter sort. Full-text
tsvector + GIN is a follow-up perf slice when/if search grows beyond
the small-family scale. Document this trade-off in the commit body.

## Frontend

### Route + entry points

- **Route:** `/suche`, new `<SearchPage />` at `apps/web/src/features/search/SearchPage.tsx`.
- **Entry points:**
  - Enable the disabled "Suche" button in `TopNav.tsx` — link to `/suche`.
  - Add a Search icon to `navItems.ts` so SideRail + BottomNav surface it at appropriate breakpoints.
  - Mobile: BottomNav's 4 slots may not have room. Instead: a Search FAB / header-icon on the home page. **Pick: add to the BottomNav** by taking the 5th slot (currently Start / Gruppen / Wochenplan / Profil — grow to Start / Gruppen / **Suche** / Wochenplan / Profil). 5 icons fit on a 390 px viewport (~72 px each).

### SearchPage

- Header: big search input (auto-focus on mount). Clear button. Sort `<Select>` — same 4 options as GroupDetail (PAGE-1) + `relevance_desc` first, labeled "Relevanz" (only shown/default when `q` is set).
- Below the input: result cards grouped by `groupName` (visually — still a flat list, but we render a subtle group-chip on each card).
- Pagination same `<Pagination />` primitive from PAGE-1.
- Empty state (`!q`): "Tippe einen Suchbegriff ein, um Rezepte aus all deinen Gruppen zu finden."
- No results (`q` set, 0 hits): "Keine Treffer für '{q}' in deinen Gruppen."
- Loading / offline states per PAGE-1 patterns.

### Hook

New `useRecipeGlobalSearch(q, { page, pageSize, sort })` in `apps/web/src/features/search/hooks.ts`. Query key `['recipe-global-search', q, sort, page]`. Enabled only when `q.length >= 1`. Debounce-via-URL identical to GroupDetailPage.

### Result card

Reuse the existing `RecipeCard` with a new optional `groupChip` prop (renders a small badge with group name, links to `/groups/{groupId}`). Click on card body navigates to `/groups/{groupId}/recipes/{recipeId}` so the user lands on the detail page inside the correct group context.

## TDD

### Backend
- Unknown sort / invalid q / invalid page / pageSize clamp.
- Authz: caller sees only their groups' recipes. Seed 3 groups, caller is member of 2, search for a recipe that exists in the 3rd group → `items=[]`.
- Empty q → 400 `invalid_query`.
- Relevance ranking: title-match ranks above description-match ranks above tag-match.
- Sort precedence: `relevance_desc` + `q` present → score DESC; other sorts ignore score entirely.
- `total` accurate across multiple groups.
- Stable tie-breaker on Id.
- Deep-link past end → empty items + honest meta.

### Frontend
- SearchPage loads with empty state when `?q=` missing.
- Typing drives URL `?q=…` after debounce.
- Sort Select options + URL wiring.
- Empty-results state.
- Result-card click navigates to per-group recipe detail.
- BottomNav + SideRail + TopNav all surface Search entry.

### E2E
`apps/web/e2e/recipe-global-search.spec.ts` — bot-login, navigate to `/suche`, type "gochujang", assert result card with group-chip, click card → detail route, URL reflects the per-group detail pathname. Credentials-gated, don't execute.

## Consumer audit

No existing callers touched — this is a net-new surface. The per-group
`/api/groups/{id}/recipes/search` endpoint stays as-is for filter-heavy
in-group browsing.

## Migrations / indexes

None in this slice. Full-text tsvector + GIN index is a deferred perf
slice.

## Scope cuts / follow-ups

- **No tsvector / full-text ranking**: deferred until scale demands it.
- **No `cook_count_desc`**: still cut (same reason as PAGE-0).
- **No fuzzy / typo-tolerance**: later.
- **No history / saved-searches**: later.
- **No per-group filter inside the global search**: use the in-group
  search for that.

## Rollout

- Lands on `main`.
- After both SEARCH-0 (backend) + SEARCH-1 (frontend) merge + review,
  tag `v0.9.3` — **the bundle tag for the pagination + search slice as
  agreed.** Triggers deploy.

## Dispatch

Two parallel agents, file-disjoint:
- SEARCH-0: backend endpoint + authz-join + relevance-ranking + tests.
- SEARCH-1: SearchPage + hook + NavItem + TopNav-button activation +
  e2e.
