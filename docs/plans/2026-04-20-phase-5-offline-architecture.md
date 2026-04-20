# Phase 5 — Offline-Modus + Sync (Architecture)

**Date:** 2026-04-20
**Status:** Active — 5 slices (OFF1..OFF5), sequential
**Priority over Phase 4:** confirmed by user 2026-04-19 ("PWA am Herd mit
WLAN-Loch hobby-wertvoller als mehr AI")

## Goal

Make the app usable on a kitchen tablet with flaky WiFi. The user can:
- **Read** previously-loaded recipes, groups, meal-plans, shopping-lists
  fully offline (read-cache persisted across sessions).
- **Write** common mutations (cook-mark, rating, slot changes, shopping-
  list checks, recipe edits) while offline — they queue in the service
  worker's background-sync queue and replay automatically on reconnect.
- **Survive conflicts** without data loss: every mutable entity gains a
  `Version`; the server returns `409 Conflict` with the current version
  on `If-Match` mismatch; the UI offers Keep-Local / Keep-Server /
  Merge-Manual resolution.

Non-goal in Phase 5:
- Offline recipe **creation** (requires staged-photo uploads which
  SeaweedFS can't queue).
- Offline chat / AI extraction.
- Multi-device merge semantics beyond "first-write-wins + 409".

## Existing foundation (what we keep)

- `vite-plugin-pwa` + Workbox runtime-caching already cached photos
  (CacheFirst) + recipes/groups GET (NetworkFirst, 2s timeout).
- TanStack Query v5 with `staleTime: 30s`, `refetchOnWindowFocus: false`.
- SignalR live-sync merges payloads via `setQueryData` (never
  `invalidateQueries`) — this pattern continues to work with a
  persisted cache: an offline replay that lands before SignalR reconnect
  doesn't double-merge.
- `MealPlan.Version` already exists (P3-9). ShoppingList, Recipe, Group
  need it added.

## Slice breakdown

### OFF1 — Read-cache persistence (Frontend-only)

**What:** Persist the TanStack Query cache to IndexedDB so a reloaded
PWA shows last-known data instantly, even offline.

**How:**
- Add `@tanstack/react-query-persist-client` +
  `@tanstack/query-sync-storage-persister` + `idb-keyval`.
- Wrap the app in `PersistQueryClientProvider` (replaces
  `QueryClientProvider` in `main.tsx`).
- Buster key: `import.meta.env.VITE_APP_VERSION` (set by build) so a
  deploy invalidates the cache automatically.
- `dehydrateOptions.shouldDehydrateQuery`: skip `['chat', ...]`,
  `['stagedPhotos', ...]`, `['imports', ...]` (progress polling is
  ephemeral), and any mutation caches.
- Max age 7 days; hashed queries >1 MB are dropped to keep IDB slim.
- `hydrateOptions.defaultOptions.queries.networkMode: 'offlineFirst'` —
  stale-while-revalidate semantics.

**Tests:**
- Persister round-trip: write queries, reload, assert hydrated.
- Buster-key change clears cache.
- `shouldDehydrateQuery` excludes chat + staged-photos.
- Offline render: simulate `navigator.onLine=false`, assert recipe-list
  renders from cache.

**Risk:** Low — client-side only, can be reverted via deploy.

### OFF2 — Mutation queue (SW background-sync)

**What:** Offline mutations queue in the SW, replay on reconnect.

**How:**
- Extend `vite.config.ts` Workbox `runtimeCaching` with a new
  `BackgroundSyncPlugin` entry for mutation endpoints:
  - `PATCH /api/recipes/:id`
  - `PATCH /api/mealplans/:planId/slots/:slotId`
  - `PATCH /api/shopping-lists/:listId/items/:itemId`
  - `POST /api/ratings`
  - `POST /api/recipes/:id/cook-mark` (if exists — else `PATCH` on
    cooked flag)
- Queue-name `fk-mutation-queue`, maxRetentionTime 24 h.
- On background sync replay: SW posts a message `mutation-replayed` to
  all clients; `useLiveSync`-adjacent hook listens and either:
  - invalidates the relevant query for a fresh GET (safe default), OR
  - waits for the SignalR event that will arrive as part of the
    server-side fan-out.
- Frontend `useNetworkStatus()` hook wraps `navigator.onLine` +
  `online`/`offline` window events + SW message for "pending replays
  count". Top-nav renders a dot + "Offline, X wartend" pill.

**Tests:**
- SW message handler enqueues POST to fk-mutation-queue on `navigator.onLine=false`.
- Replay on `online` fires pending mutations.
- Max retention expires old queue entries without crashing UI.
- `useNetworkStatus` reflects offline + pending-count.

**Risk:** Medium — SW behavior hard to test in jsdom; use Playwright
or workbox's own test harness where possible.

### OFF3 — Backend ETag + Version + 409 (Backend)

**What:** Optimistic concurrency control on mutation endpoints.

**How:**
- New `IVersionedEntity` marker interface + `Version` (int) column on
  `Recipe`, `Group`, `ShoppingList`, `ShoppingListItem`. (`MealPlan`
  already has it.)
- EF migration `AddVersionToMutables` — default 0, NOT NULL.
- `VersionBumpExtension.BumpVersion(this IVersionedEntity)` increments
  in domain-logic on every mutation (same pattern as MealPlan).
- New `ETagHelper.Compute(id, version) => $"W/\"{id}-{version}\""` +
  `ETagHelper.TryParse(header) => (Guid, int)?`.
- Mutation endpoints (PATCH recipes, PATCH slots, PATCH shopping-list
  items, POST ratings): read `If-Match` header; if present AND parsed
  version < current DB version → return `409 Conflict` with body
  `{ code: "version_mismatch", currentVersion: N, current: <dto> }`.
- GET endpoints return `ETag` header + `Cache-Control: private, max-age=0`.
- New FamilienResults.Conflict helper mirroring BadRequest shape.

**Tests:**
- Domain: BumpVersion on all mutation sites (10+ sites across 4 entities).
- Endpoint: GET returns ETag, PATCH with correct If-Match succeeds,
  PATCH with stale If-Match returns 409 with current version + DTO.
- Absent If-Match: mutation proceeds as today (backward-compat).
- ETag format is stable across identical states.

**Risk:** Medium — changes touch many endpoints; must not break
existing clients that don't send If-Match.

### OFF4 — Conflict-resolution UI (Frontend)

**What:** When a 409 comes back, show a dialog letting the user choose
resolution.

**How:**
- New `<ConflictDialog />` primitive in `features/_shared/` using the
  existing FixedOverlayDialog pattern (from BUG-004 + shadcn).
- Three action buttons: "Lokale Version behalten" (retry with server's
  current version + local patch), "Server-Version übernehmen" (abort
  local change, invalidate query), "Manuell zusammenführen" (open a
  field-by-field diff editor — only for recipes; slots + items use
  simpler two-button flow because there's less to merge).
- `useConflictResolver<T>()` hook — takes the mutation function + a
  merge strategy. On 409, captures the conflict and opens dialog.
- Per-resource diff renderers:
  - Recipe: title, description, ingredients, steps diff with visual
    delete/add markers.
  - MealPlanSlot: side-by-side "Mittag/Abend/recipe/label" fields.
  - ShoppingListItem: checkbox + quantity + note (usually the
    server-side toggle wins — the UI leads with "Server übernehmen").

**Tests:**
- Dialog renders with the three actions.
- Each action path: mutation re-dispatches with correct expected-version,
  or invalidates.
- Recipe diff renderer: 3 fixture conflicts (add ingredient, change
  title, reorder steps).

**Risk:** Medium-high — UI complexity. Scope-control: MealPlanSlot +
ShoppingListItem get the simple two-button flow; only Recipe needs the
full merge editor.

### OFF5 — Offline coverage + integration smoke

**What:** Close the loop with a full E2E test and operator docs.

**How:**
- Playwright test `e2e/offline.spec.ts`:
  - Load recipe detail page (warm cache).
  - `page.context().setOffline(true)`.
  - Navigate to another recipe — cached render works.
  - Check a shopping-list item — optimistic UI + enqueued mutation.
  - `setOffline(false)` — assert mutation fires, UI stays consistent.
- `docs/ops.md` §9 "Offline behavior":
  - Which endpoints cache.
  - Queue flush timing.
  - Conflict UX and how to reason about 409s server-side.
- Top-nav network indicator polish (already in OFF2 — this is the
  visual QA pass).
- Version bump: `v0.7.0`. Full gates on all four suites.

**Risk:** Low — consolidation + docs.

## Ordering + dispatch

Slices run **sequential** (user preference from Bug-Sweep-2). Each slice
uses the 4-stage flow where risk-appropriate:

- OFF1: impl + reviewer (frontend-only, low-risk). Skip simplify +
  security unless reviewer flags.
- OFF2: impl + simplify + security-review + reviewer. Service worker
  changes are security-sensitive (cache-poisoning, replay of
  unauthorized mutations).
- OFF3: impl + simplify + security-review + reviewer. Backend mutations
  + new header-parsing = audit-worthy.
- OFF4: impl + reviewer. UI-layer; no new backend surface.
- OFF5: impl + reviewer. Mostly docs + E2E.

After OFF5: tag `v0.7.0`, push, watch deploy, smoke.

## Verification gates (every slice)

```bash
cd apps/web && pnpm test --run && pnpm lint && pnpm build
cd apps/api && dotnet test --nologo
cd apps/python-extractor && uv run pytest && uv run ruff check && uv run mypy src
cd packages/shared && pnpm test --run
```

Lint + build are CRITICAL — prior deploys tripped on CI-stricter rules
than local.

## Scope deviations allowed

Any deviation from this plan is acceptable if:
- It's documented in the slice commit + the `docs/design-implementation-progress.md` entry.
- It doesn't regress an existing test.
- It's security-neutral or explicitly security-positive.

## Dependencies

- `@tanstack/react-query-persist-client`, `@tanstack/query-sync-storage-persister`,
  `idb-keyval` — new NPM dependencies for OFF1.
- Workbox already bundled via `vite-plugin-pwa` — no new NPM dep for OFF2.
- No new NuGet dependencies for OFF3 — ETag handling built on
  `Microsoft.Net.Http.Headers.EntityTagHeaderValue`.
- No new deps for OFF4 / OFF5.

---

End of architecture doc. Implementation starts with OFF1.
