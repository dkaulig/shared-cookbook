import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Link,
  Navigate,
  useNavigate,
  useOutlet,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ChevronDown, ChevronUp, Plus, Users } from 'lucide-react'
import type { RecipeSearchParams, SearchSort } from '@familien-kochbuch/shared'
import {
  DEFAULT_RECIPE_LIST_PAGE_SIZE,
  DEFAULT_RECIPE_LIST_SORT,
} from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/pagination'
import { Select } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { classifyMutationError } from '@/features/_shared/errorSurface'
import { RecipeGridCard } from '@/features/recipes/RecipeGridCard'
import { useGroupTags } from '@/features/recipes/hooks'
import { ActiveFilterChips } from '@/features/search/ActiveFilterChips'
import { RecipeFilterPanel } from '@/features/search/RecipeFilterPanel'
import { useRecipeSearch } from '@/features/search/hooks'
import { fetchRandomRecipe } from '@/features/search/searchApi'
import {
  readFiltersFromSearchParams,
  writeFiltersToSearchParams,
} from '@/features/search/urlState'
import { usePresetConsumer } from '@/features/search/usePresetConsumer'
import { GroupDetailHeader } from './GroupDetailHeader'
import { GroupFilterBar } from './GroupFilterBar'
import { GroupMembersAndInvitesPanel } from './GroupMembersAndInvitesPanel'
import { useGroup } from './hooks'
import { useBottomZoneSlot } from '@/components/layout/bottomZone'
import { SplitPane } from '@/components/layout/SplitPane'
import { useIsMobile } from '@/lib/useIsMobile'

/**
 * DS4 Group Detail page.
 *
 * Mirrors `docs/mockups/warme-kueche-group-detail.html` end-to-end:
 *   - Sub-top-nav with back button + title + meta line + settings gear
 *   - `<GroupDetailHeader />`: cover banner, overlapping avatar, name,
 *     description, stats row
 *   - `<GroupFilterBar />`: search + Filter toggle + Zufall
 *   - Active-filter chips row + expanded `<RecipeFilterPanel />` (owned
 *     by the panel component itself)
 *   - Results header: "N Rezepte in [Gruppe]" + sort indicator
 *   - Recipe grid (2/3/4 columns responsive)
 *   - FAB bottom-right → `/groups/:id/recipes/new`
 *
 * Data: `useGroup(id)` for detail, `useRecipeSearch(id, filters)` for
 * the grid, `fetchRandomRecipe` for Zufall. URL search-params drive
 * filter state so the view is shareable/reloadable.
 */
/**
 * PAGE-1 — sort options that drive the recipe list. German labels are
 * the ones the user sees in the header `<Select>`. Order matches the
 * design doc: default first, then by how likely the user is to reach
 * for each option.
 *
 * PAGE-0 cut `cook_count_desc` because neither a `TimesCooked` column
 * nor a `CookHistory` aggregation table exists yet. A follow-up slice
 * can re-introduce the option once the schema supports it; the shared
 * `SearchSort` union still carries the value so frontend + backend can
 * wire it in without a breaking-type churn.
 */
/**
 * Sort values are stable; their labels are looked up per-render via
 * the `groups.detail.sort*` translation keys so the header <Select>
 * flips locale with `i18n.changeLanguage()`.
 */
const SORT_VALUES = [
  'updated_desc',
  'cooked_desc',
  'title_asc',
  'rating_desc',
] as const satisfies readonly SearchSort[]

// Mirror the PAGE-0 backend defaults so share-links + empty-state
// escape-hatches agree on what "page 1, default sort" means.
const DEFAULT_SORT: SearchSort = DEFAULT_RECIPE_LIST_SORT
const DEFAULT_PAGE_SIZE = DEFAULT_RECIPE_LIST_PAGE_SIZE

export function GroupDetailPage() {
  const { t } = useTranslation()
  const params = useParams<{ groupId: string }>()
  const navigate = useNavigate()
  const groupId = params.groupId ?? ''
  const detail = useGroup(groupId)
  const tagsQuery = useGroupTags(groupId)

  const sortLabel: Record<SearchSort, string> = {
    updated_desc: t('groups.detail.sortUpdatedDesc'),
    cooked_desc: t('groups.detail.sortCookedDesc'),
    title_asc: t('groups.detail.sortTitleAsc'),
    rating_desc: t('groups.detail.sortRatingDesc'),
  }

  const [searchParams, setSearchParams] = useSearchParams()
  const filters = readFiltersFromSearchParams(searchParams)

  // PAGE-1 — pagination + sort are URL-driven so the view is share-/
  // reload-safe. The sort defaults to the list-endpoint's
  // `updated_desc`, but we honour whatever the URL supplies (including
  // legacy `newest|best_rated|last_cooked` picked up by the search
  // endpoint pre-PAGE-1). `page` is 1-based; absent → 1.
  const urlPage = filters.page && filters.page > 0 ? filters.page : 1
  const urlSort: SearchSort = filters.sort ?? DEFAULT_SORT
  const search = useRecipeSearch(groupId, {
    ...filters,
    page: urlPage,
    pageSize: filters.pageSize ?? DEFAULT_PAGE_SIZE,
    sort: urlSort,
  })

  // Debounced search input — tracks user keystrokes locally, then
  // commits to the URL after 300 ms so typing doesn't slam the backend.
  // Critical: the initial mount must NOT fire (it would wipe the
  // `?preset=…` param before `usePresetConsumer` gets its chance). We
  // track a `hasUserTyped` flag that only flips true on the first real
  // `setSearchInput` call from the `<GroupFilterBar />`.
  const [searchInput, setSearchInput] = useState(filters.q ?? '')
  const [hasUserTyped, setHasUserTyped] = useState(false)
  const onSearchChange = useCallback((next: string) => {
    setHasUserTyped(true)
    setSearchInput(next)
  }, [])
  useEffect(() => {
    if (!hasUserTyped) return
    const handle = setTimeout(() => {
      const trimmed = searchInput.trim()
      const current = readFiltersFromSearchParams(searchParams)
      const next: RecipeSearchParams = { ...current, q: trimmed === '' ? undefined : trimmed }
      const nextParams = writeFiltersToSearchParams(next)
      if (nextParams.toString() !== searchParams.toString()) {
        setSearchParams(nextParams, { replace: true })
      }
    }, 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only searchInput/hasUserTyped drive the debounce
  }, [searchInput, hasUserTyped])

  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  const [membersPanelOpen, setMembersPanelOpen] = useState(false)
  const [randomPending, setRandomPending] = useState(false)
  const [randomError, setRandomError] = useState<string | null>(null)

  const activeFilterCount = useMemo(() => countActiveFilters(filters), [filters])

  /**
   * PAGE-1 — sort change resets `page` to 1 (otherwise a deep
   * `?sort=X&page=5` reshuffle could strand the user on an empty tail
   * page). Preserves every other filter. The default sort strips itself
   * from the URL so share-links don't carry needless noise.
   */
  const handleSortChange = useCallback(
    (next: SearchSort) => {
      const current = readFiltersFromSearchParams(searchParams)
      const nextFilters: RecipeSearchParams = {
        ...current,
        sort: next === DEFAULT_SORT ? undefined : next,
        page: undefined,
      }
      setSearchParams(writeFiltersToSearchParams(nextFilters))
    },
    [searchParams, setSearchParams],
  )

  /**
   * PAGE-1 — page-change preserves sort + every other filter. Page 1
   * strips itself from the URL (default) for clean share-links.
   */
  const handlePageChange = useCallback(
    (nextPage: number) => {
      const current = readFiltersFromSearchParams(searchParams)
      const nextFilters: RecipeSearchParams = {
        ...current,
        page: nextPage <= 1 ? undefined : nextPage,
      }
      setSearchParams(writeFiltersToSearchParams(nextFilters))
    },
    [searchParams, setSearchParams],
  )

  const handleRandom = useCallback(async () => {
    if (!groupId) return
    setRandomError(null)
    setRandomPending(true)
    try {
      const currentFilters = readFiltersFromSearchParams(searchParams)
      const res = await fetchRandomRecipe(groupId, currentFilters)
      if (res.recipeId) {
        navigate(`/groups/${groupId}/recipes/${res.recipeId}`)
      } else {
        setRandomError(t('groups.detail.randomEmpty'))
      }
    } catch (err) {
      // REL-3f — localise via errors.json + drop 5xx leaks.
      setRandomError(classifyMutationError(err).message)
    } finally {
      setRandomPending(false)
    }
  }, [groupId, navigate, searchParams, t])

  // Preset consumer runs at the page level so it fires even when the
  // filter panel is still collapsed (the common case after arriving
  // from the Home quick-filter chips).
  usePresetConsumer({
    tags: tagsQuery.data,
    tagsReady: tagsQuery.isSuccess,
    onRandomRequest: handleRandom,
  })

  // TABLET-1 — at `md:+` we render a two-column SplitPane. The RIGHT
  // pane hosts either the nested `<Outlet />` (when the URL resolves a
  // child route like `/groups/:id/recipes/:recipeId`) or a German
  // empty-state prompt. `useOutlet()` returns `null` when no child is
  // matched, which is the cleanest signal we have for the empty state
  // without coupling to specific child paths. Keep this hook BEFORE any
  // early return so the call order stays stable across renders.
  const outletNode = useOutlet()
  // `useIsMobile()` tracks `(max-width: 767px)` — the complement of
  // Tailwind's `md:` breakpoint. Below `md:` the page falls back to its
  // original single-column flow: when a recipe is selected the outlet
  // takes over the whole `<main>` (mirrors the pre-TABLET-1 behaviour
  // where `/groups/:id/recipes/:recipeId` replaced `<main>` entirely).
  const isMobile = useIsMobile()

  // BUG-036 — replace the old floating round FAB (fixed bottom-right)
  // with a full-width primary button in the unified Bottom-Zone slot.
  // Same target (`/groups/:groupId/recipes/new`), just folded into
  // the shared BottomNav container so there's no overlap math per
  // page.
  //
  // 2026-04-22 slot-conflict fix #2 — when a nested recipe route is
  // active (`hasOutlet === true`), the child RecipeDetailPage ALSO
  // calls `useBottomZoneSlot(RecipeActionBar)`. React fires effects
  // depth-first post-order: child first, THEN parent on a combined
  // render. An earlier attempt to "pass null from the parent when
  // child is mounted" still overwrites the child's slot with null,
  // so the user saw NO action bar on recipe detail pages.
  //
  // Real fix: pass `{ disabled: hasOutlet }` so the hook's inner
  // effect skips the `set()` call entirely when the child is the
  // legitimate owner. Parent yields ownership — child's ActionBar
  // renders unopposed.
  const hasOutlet = outletNode != null
  useBottomZoneSlot(
    groupId ? (
      <Link
        to={`/groups/${groupId}/recipes/new`}
        aria-label={t('groups.detail.newRecipeAria')}
        className={cn(
          'flex-1 inline-flex items-center justify-center gap-2 rounded-[12px] border border-[hsl(var(--primary))] bg-[hsl(var(--primary))] px-4 py-[11px] text-[15px] font-semibold text-[hsl(var(--primary-foreground))]',
          'shadow-[0_4px_12px_-4px_rgba(180,83,9,0.45)] transition-colors hover:bg-[hsl(var(--primary-hover,var(--primary)))] active:scale-[0.99]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        )}
      >
        <Plus className="h-[18px] w-[18px]" strokeWidth={2.4} aria-hidden="true" />
        {t('groups.detail.newRecipeLabel')}
      </Link>
    ) : null,
    [groupId, t],
    { disabled: hasOutlet },
  )

  if (!groupId) return <Navigate to="/groups" replace />

  if (detail.isLoading) {
    return (
      <div
        className="mx-auto w-full max-w-[1120px] px-5 py-6 md:px-8"
        aria-label={t('groups.detail.loadingAria')}
      >
        <Skeleton className="mb-4 h-5 w-32" />
        <Skeleton className="mb-3 h-[120px] w-full rounded-[24px] md:h-[180px]" />
        <Skeleton className="mb-2 h-8 w-2/3" />
        <Skeleton className="mb-6 h-4 w-1/2" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  if (detail.isError) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          {t('groups.detail.loadError')}
        </p>
        <Link to="/groups" className="mt-4 inline-block text-sm underline">
          {t('groups.detail.backToList')}
        </Link>
      </main>
    )
  }

  if (!detail.isSuccess) return null

  const group = detail.data
  const roleLabel =
    group.myRole === 'Admin'
      ? t('groups.detail.roleAdmin')
      : t('groups.detail.roleMember')
  const totalRecipes = search.data?.total ?? 0
  const items = search.data?.items ?? []
  const tags = tagsQuery.data ?? []

  const hasFiltersOrQuery = activeFilterCount > 0 || !!filters.q

  const listPane = (
    <div className="mx-auto w-full max-w-[1120px]">
      {/* Sub-top-nav inside the app shell. AppLayout already owns the
          global TopNav above this — this is the page-scoped sub-nav. */}
      {/* Sticky page sub-nav. z-20 so it sits ABOVE the GroupDetailHeader
          avatar (z-10) when the page scrolls — otherwise the avatar slid
          on top of the back-arrow (BUG-005). Same scale as the global
          TopNav (also z-20); they sit stacked vertically so equal z is
          fine.
          BUG-020 — the trailing cog button used to live here and pointed
          at `/groups/:id/tags`, but its `aria-label="Einstellungen"`
          collided with the same-named pill in `GroupDetailHeader` (which
          actually leads to settings). The pill is now the sole entry to
          settings; tag management is a section of that page. */}
      <nav
        className={cn(
          // BUG-032: anchor the sub-nav's sticky `top` to the shared
          // `--topnav-height` CSS var (was hard-coded `top-[56px]`).
          // z-10 keeps the global TopNav (z-20) on top on any y-overlap
          // during iOS/Chrome toolbar retraction.
          'sticky top-0 z-10 flex items-center gap-2.5 border-b border-border/60 px-4 py-2.5',
          'bg-[hsl(var(--background)/0.88)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background)/0.75)]',
        )}
        aria-label={t('groups.detail.subNavAria')}
      >
        <Link
          to="/groups"
          aria-label={t('groups.detail.backAria')}
          className="grid h-10 w-10 place-items-center rounded-[10px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground"
        >
          <ArrowLeft className="h-[18px] w-[18px]" aria-hidden="true" />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col gap-0 leading-[1.1]">
          <span className="truncate font-serif text-[18px] font-semibold tracking-[-0.005em]">
            {group.name}
          </span>
          <span className="flex items-center gap-1 text-[11px] text-[hsl(var(--muted-foreground))]">
            <span>
              {t('groups.detail.recipe', { count: totalRecipes })}
            </span>
            <span aria-hidden="true" className="text-[hsl(var(--input))]">·</span>
            <span>
              {t('groups.detail.member', { count: group.memberCount })}
            </span>
            <span aria-hidden="true" className="text-[hsl(var(--input))]">·</span>
            <span>{roleLabel}</span>
          </span>
        </div>
      </nav>

      <GroupDetailHeader group={group} recipeCount={totalRecipes} />

      <div className="px-5 pt-4 md:px-8 md:pt-5">
        <button
          type="button"
          onClick={() => setMembersPanelOpen((v) => !v)}
          aria-expanded={membersPanelOpen}
          aria-controls="members-and-invites-panel"
          className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-[hsl(var(--primary)/0.06)]"
        >
          <Users className="h-4 w-4 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
          {t('groups.detail.membersToggle')}
          {membersPanelOpen ? (
            <ChevronUp className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
        {membersPanelOpen && (
          <div id="members-and-invites-panel" className="mt-3">
            <GroupMembersAndInvitesPanel group={group} />
          </div>
        )}
      </div>

      <div className="px-5 pt-6 md:px-8 md:pt-7">
        <GroupFilterBar
          searchQuery={searchInput}
          onSearchChange={onSearchChange}
          activeFilterCount={activeFilterCount}
          isFilterOpen={filterPanelOpen}
          onToggleFilter={() => setFilterPanelOpen((v) => !v)}
          onRandomPick={handleRandom}
          isRandomPending={randomPending}
        />

        {randomError && (
          <p
            role="alert"
            className="mt-3 rounded-md bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
          >
            {randomError}
          </p>
        )}

        {/* Active filters are always shown when present — even if the
            panel body is collapsed — so the user sees what's applied
            and can × individual chips without re-opening the panel. */}
        {activeFilterCount > 0 && (
          <div className="mt-3">
            <ActiveFilterChips groupId={groupId} />
          </div>
        )}

        {/* The expanded filter panel (tags + sliders + dropdowns) only
            mounts when the user has toggled the Filter button open. */}
        {filterPanelOpen && (
          <div className="mt-3">
            <RecipeFilterPanel groupId={groupId} />
          </div>
        )}
      </div>

      {/* Results header — PAGE-1 replaces the passive sort-indicator
          with an interactive <Select> so the user can pick one of 5
          sort orders. The Select writes `?sort=…` to the URL (sort
          change resets `page=1` in the handler). */}
      <div className="flex flex-wrap items-baseline justify-between gap-2.5 px-5 pb-2 pt-[18px] md:px-8 md:pt-[22px]">
        <div className="font-serif text-[22px] font-semibold">
          {t('groups.detail.recipe', { count: totalRecipes })}
          <span className="ml-1.5 font-sans text-[13px] font-medium text-[hsl(var(--muted-foreground))]">
            {t('groups.detail.recipesInGroupTemplate', { name: group.name })}
          </span>
        </div>
        <label className="inline-flex items-center gap-2 text-[13px] text-[hsl(var(--muted-foreground))]">
          <span className="sr-only">{t('groups.detail.sortAria')}</span>
          <Select
            aria-label={t('groups.detail.sortAria')}
            value={urlSort}
            onChange={(e) => handleSortChange(e.target.value as SearchSort)}
            className="h-9 w-auto min-w-[180px] text-sm"
          >
            {SORT_VALUES.map((value) => (
              <option key={value} value={value}>
                {sortLabel[value]}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {/* Recipe grid */}
      <div className="px-5 pb-8 pt-2.5 md:px-8 md:pb-10">
        {search.isLoading && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                role="status"
                className="aspect-[4/3] animate-pulse rounded-[18px] bg-muted"
              />
            ))}
          </div>
        )}

        {search.isError && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
            {t('groups.detail.recipesLoadError')}
          </p>
        )}

        {/* PAGE-1 — deep-link past the last page (`?page=99` on a
            3-page list) lands here: total > 0 but items is empty.
            Render a bespoke empty-state with a "Zur ersten Seite"
            escape-hatch rather than conflating with the no-recipes /
            no-filter-matches branches below. */}
        {search.isSuccess &&
          items.length === 0 &&
          urlPage > 1 &&
          totalRecipes > 0 && (
            <EmptyPastEnd
              firstPageHref={buildFirstPageHref(searchParams)}
            />
          )}

        {search.isSuccess &&
          items.length === 0 &&
          !(urlPage > 1 && totalRecipes > 0) && (
            <EmptyState
              hasFilters={hasFiltersOrQuery}
              onClearFilters={() =>
                setSearchParams(writeFiltersToSearchParams({}), { replace: true })
              }
              newRecipeHref={`/groups/${groupId}/recipes/new`}
            />
          )}

        {search.isSuccess && items.length > 0 && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-4">
            {items.map((recipe) => (
              <RecipeGridCard
                key={recipe.id}
                recipe={recipe}
                tags={tags}
                prepTimeMinutes={null}
              />
            ))}
          </div>
        )}

        {/* PAGE-1 — pagination nav. Hidden when total ≤ pageSize
            (one-page lists don't need chrome). Sits under the grid on
            mobile; the md+ SplitPane keeps it in the natural flow at
            the bottom of the left column's scroll container. */}
        {search.isSuccess && totalRecipes > 0 && (
          <Pagination
            page={urlPage}
            totalPages={Math.max(
              1,
              Math.ceil(totalRecipes / (filters.pageSize ?? DEFAULT_PAGE_SIZE)),
            )}
            onPageChange={handlePageChange}
          />
        )}
      </div>

      {/* BUG-036 — the contextual "Neues Rezept" button now lives in
          the unified Bottom-Zone slot (see `useBottomZoneSlot` above).
          The old floating round FAB has been replaced by a full-width
          primary button for consistency with other contextual actions
          (RecipeActionBar, FormActionBar). */}
    </div>
  )

  const rightPane = outletNode ?? (
    <div
      className="flex h-full items-center justify-center px-6 py-10 text-center text-[hsl(var(--muted-foreground))]"
      role="status"
    >
      <p className="max-w-sm text-[15px] leading-[1.5]">
        {t('groups.detail.outletEmpty')}
      </p>
    </div>
  )

  // Mobile flow: if the user has drilled into a recipe, the nested
  // outlet takes over the whole `<main>` so RecipeDetailPage isn't
  // mounted twice (once here, once in the SplitPane). Without a child
  // route, the list pane renders inline as before.
  if (isMobile) {
    return <>{outletNode ?? listPane}</>
  }

  return (
    <SplitPane
      leftLabel={t('groups.detail.splitLeftLabel')}
      rightLabel={t('groups.detail.splitRightLabel')}
      left={listPane}
      right={rightPane}
      className="h-full"
    />
  )
}

/**
 * PAGE-1 — build the href that drops the `page` URL param (back to
 * page 1) while preserving every other filter. Used by the "past-end"
 * empty-state so a deep-linked `?page=99` gives the user a one-click
 * escape without losing their sort/filters context.
 */
function buildFirstPageHref(current: URLSearchParams): string {
  const next = new URLSearchParams(current)
  next.delete('page')
  const qs = next.toString()
  return qs ? `?${qs}` : '?'
}

function EmptyPastEnd({ firstPageHref }: { firstPageHref: string }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 px-6 py-10 text-center">
      <p className="font-serif text-[22px] font-semibold text-foreground">
        {t('groups.detail.emptyPastEndTitle')}
      </p>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t('groups.detail.emptyPastEndBody')}
      </p>
      <div className="mt-4">
        <Link
          to={firstPageHref}
          className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-[hsl(var(--primary)/0.08)]"
        >
          {t('groups.detail.emptyPastEndCta')}
        </Link>
      </div>
    </div>
  )
}

function countActiveFilters(filters: RecipeSearchParams): number {
  let n = 0
  if (filters.tags && filters.tags.length > 0) n += filters.tags.length
  if (filters.minRating != null) n += 1
  if (filters.maxPrepTime != null) n += 1
  if (filters.createdBy) n += 1
  return n
}

function EmptyState({
  hasFilters,
  onClearFilters,
  newRecipeHref,
}: {
  hasFilters: boolean
  onClearFilters: () => void
  newRecipeHref: string
}) {
  const { t } = useTranslation()
  if (hasFilters) {
    return (
      <div className="rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 px-6 py-10 text-center">
        <p className="font-serif text-[22px] font-semibold text-foreground">
          {t('groups.detail.emptyFilteredTitle')}
        </p>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          {t('groups.detail.emptyFilteredBody')}
        </p>
        <div className="mt-4">
          <Button type="button" variant="outline" onClick={onClearFilters}>
            {t('groups.detail.emptyFilteredReset')}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 px-6 py-10 text-center">
      <p className="font-serif text-[22px] font-semibold text-foreground">
        {t('groups.detail.emptyTitle')}
      </p>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t('groups.detail.emptyBody')}
      </p>
      <div className="mt-4">
        <Button asChild>
          <Link to={newRecipeHref}>{t('groups.detail.emptyCreateCta')}</Link>
        </Button>
      </div>
    </div>
  )
}
