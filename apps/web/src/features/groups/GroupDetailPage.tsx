import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ListOrdered, Plus, Settings } from 'lucide-react'
import type { ApiError, RecipeSearchParams, SearchSort } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { RecipeGridCard } from '@/features/recipes/RecipeGridCard'
import { useGroupTags } from '@/features/recipes/hooks'
import { RecipeFilterPanel } from '@/features/search/RecipeFilterPanel'
import { useRecipeSearch } from '@/features/search/hooks'
import { fetchRandomRecipe } from '@/features/search/searchApi'
import {
  readFiltersFromSearchParams,
  writeFiltersToSearchParams,
} from '@/features/search/urlState'
import { GroupDetailHeader } from './GroupDetailHeader'
import { GroupFilterBar } from './GroupFilterBar'
import { useGroup } from './hooks'

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
const SORT_LABELS: Record<SearchSort, string> = {
  newest: 'Neueste zuerst',
  best_rated: 'Am besten bewertet',
  last_cooked: 'Zuletzt gekocht',
}

export function GroupDetailPage() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const groupId = params.id ?? ''
  const detail = useGroup(groupId)
  const tagsQuery = useGroupTags(groupId)

  const [searchParams, setSearchParams] = useSearchParams()
  const filters = readFiltersFromSearchParams(searchParams)
  const search = useRecipeSearch(groupId, filters)

  // Debounced search input — tracks user keystrokes locally, then
  // commits to the URL after 300 ms so typing doesn't slam the backend.
  const [searchInput, setSearchInput] = useState(filters.q ?? '')
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchInput.trim()
      const next: RecipeSearchParams = { ...filters, q: trimmed === '' ? undefined : trimmed }
      const nextParams = writeFiltersToSearchParams(next)
      if (nextParams.toString() !== searchParams.toString()) {
        setSearchParams(nextParams, { replace: true })
      }
    }, 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only searchInput drives the debounce
  }, [searchInput])

  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  const [randomPending, setRandomPending] = useState(false)
  const [randomError, setRandomError] = useState<string | null>(null)

  const activeFilterCount = useMemo(() => countActiveFilters(filters), [filters])
  const sortLabel = SORT_LABELS[filters.sort ?? 'newest']

  if (!groupId) return <Navigate to="/groups" replace />

  if (detail.isLoading) {
    return (
      <div className="mx-auto w-full max-w-[1120px] px-5 py-6 md:px-8" aria-label="Gruppe wird geladen">
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
          Gruppe konnte nicht geladen werden.
        </p>
        <Link to="/groups" className="mt-4 inline-block text-sm underline">
          Zurück zu den Gruppen
        </Link>
      </main>
    )
  }

  if (!detail.isSuccess) return null

  const group = detail.data
  const roleLabel = group.myRole === 'Admin' ? 'Admin' : 'Mitglied'
  const totalRecipes = search.data?.total ?? 0
  const items = search.data?.items ?? []
  const tags = tagsQuery.data ?? []

  async function handleRandom() {
    setRandomError(null)
    setRandomPending(true)
    try {
      const res = await fetchRandomRecipe(groupId, filters)
      if (res.recipeId) {
        navigate(`/groups/${groupId}/recipes/${res.recipeId}`)
      } else {
        setRandomError('Kein Rezept passt zu den aktuellen Filtern.')
      }
    } catch (err) {
      const apiErr = err as ApiError
      setRandomError(apiErr.message || 'Zufalls-Auswahl fehlgeschlagen.')
    } finally {
      setRandomPending(false)
    }
  }

  const hasFiltersOrQuery = activeFilterCount > 0 || !!filters.q
  const recipesLabel = totalRecipes === 1 ? 'Rezept' : 'Rezepte'

  return (
    <div className="mx-auto w-full max-w-[1120px]">
      {/* Sub-top-nav inside the app shell. AppLayout already owns the
          global TopNav above this — this is the page-scoped sub-nav. */}
      <nav
        className={cn(
          'sticky top-[56px] z-[9] flex items-center gap-2.5 border-b border-border/60 px-4 py-2.5',
          'bg-[hsl(var(--background)/0.88)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background)/0.75)]',
        )}
        aria-label="Gruppen-Navigation"
      >
        <Link
          to="/groups"
          aria-label="Zurück"
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
              {totalRecipes} {recipesLabel}
            </span>
            <span aria-hidden="true" className="text-[hsl(var(--input))]">·</span>
            <span>
              {group.memberCount} {group.memberCount === 1 ? 'Mitglied' : 'Mitglieder'}
            </span>
            <span aria-hidden="true" className="text-[hsl(var(--input))]">·</span>
            <span>{roleLabel}</span>
          </span>
        </div>
        <Link
          to={`/groups/${groupId}/tags`}
          aria-label="Einstellungen"
          className="grid h-10 w-10 place-items-center rounded-[10px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground"
        >
          <Settings className="h-[18px] w-[18px]" aria-hidden="true" />
        </Link>
      </nav>

      <GroupDetailHeader group={group} recipeCount={totalRecipes} />

      <div className="px-5 pt-6 md:px-8 md:pt-7">
        <GroupFilterBar
          searchQuery={searchInput}
          onSearchChange={setSearchInput}
          activeFilterCount={activeFilterCount}
          isFilterOpen={filterPanelOpen}
          onToggleFilter={() => setFilterPanelOpen((v) => !v)}
          onRandomPick={handleRandom}
          isRandomPending={randomPending}
        />

        {randomError && (
          <p
            role="alert"
            className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200"
          >
            {randomError}
          </p>
        )}

        {/* The filter panel hosts its own active-filter chips row, the
            reset button, and the collapsible panel body. We control
            visibility of the whole thing via `filterPanelOpen`; the
            chip row is useful even when collapsed so we render it
            unconditionally (panel component already guards chips). */}
        {filterPanelOpen && (
          <div className="mt-4">
            <RecipeFilterPanel groupId={groupId} />
          </div>
        )}

        {/* If the panel is closed, still show the active-filter chips so
            users know what's applied. We render the panel inline only
            when open to match the mockup toggle affordance. */}
        {!filterPanelOpen && activeFilterCount > 0 && (
          <div className="mt-3">
            <RecipeFilterPanel groupId={groupId} />
          </div>
        )}
      </div>

      {/* Results header */}
      <div className="flex items-baseline justify-between gap-2.5 px-5 pb-2 pt-[18px] md:px-8 md:pt-[22px]">
        <div className="font-serif text-[22px] font-semibold">
          {totalRecipes} {recipesLabel}
          <span className="ml-1.5 font-sans text-[13px] font-medium text-[hsl(var(--muted-foreground))]">
            in {group.name}
          </span>
        </div>
        <div className="inline-flex items-center gap-1 text-[13px] text-[hsl(var(--muted-foreground))]">
          <ListOrdered className="h-[13px] w-[13px]" aria-hidden="true" />
          {sortLabel}
        </div>
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
            Rezepte konnten nicht geladen werden.
          </p>
        )}

        {search.isSuccess && items.length === 0 && (
          <EmptyState
            hasFilters={hasFiltersOrQuery}
            onClearFilters={() => setSearchParams(writeFiltersToSearchParams({}), { replace: true })}
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
      </div>

      {/* FAB — fixed bottom-right. The BottomNav's own centre FAB goes
          to /groups (the group-picker); this one is contextual (creates
          inside THIS group). Sits above BottomNav on mobile via bottom
          inset math. */}
      <Link
        to={`/groups/${groupId}/recipes/new`}
        aria-label="Neues Rezept anlegen"
        className={cn(
          'fixed right-4 z-20 grid h-[56px] w-[56px] place-items-center rounded-full bg-primary text-primary-foreground',
          'shadow-[0_8px_24px_-6px_rgba(180,83,9,0.55),0_2px_6px_rgba(0,0,0,0.08)]',
          'transition-[background-color,transform] duration-150 hover:bg-[hsl(var(--primary-hover))] active:scale-95',
          'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[hsl(var(--primary)/0.3)]',
        )}
        style={{ bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
      >
        <Plus className="h-6 w-6" strokeWidth={2.4} aria-hidden="true" />
      </Link>
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
  if (hasFilters) {
    return (
      <div className="rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 px-6 py-10 text-center">
        <p className="font-serif text-[22px] font-semibold text-foreground">Kein Treffer</p>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          Keine Rezepte passen zu den aktuellen Filtern.
        </p>
        <div className="mt-4">
          <Button type="button" variant="outline" onClick={onClearFilters}>
            Filter zurücksetzen
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 px-6 py-10 text-center">
      <p className="font-serif text-[22px] font-semibold text-foreground">Noch keine Rezepte</p>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        Leg gleich eines an — dein erstes Familienrezept wartet.
      </p>
      <div className="mt-4">
        <Button asChild>
          <Link to={newRecipeHref}>Rezept anlegen</Link>
        </Button>
      </div>
    </div>
  )
}
