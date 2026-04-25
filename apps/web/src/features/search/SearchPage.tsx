import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { GlobalSearchSort } from '@shared-cookbook/shared'
import {
  DEFAULT_GLOBAL_SEARCH_PAGE_SIZE,
  DEFAULT_GLOBAL_SEARCH_SORT,
} from '@shared-cookbook/shared'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { RecipeGridCard } from '@/features/recipes/RecipeGridCard'
import { useRecipeGlobalSearch } from './useRecipeGlobalSearch'

/**
 * SEARCH-1 — cross-group search page (`/suche`).
 *
 * Sticky header with an auto-focus input + clear button + sort <Select>,
 * followed by a 2/3/4-column grid of {@link RecipeGridCard}s pulled via
 * {@link useRecipeGlobalSearch}. The owning-group is surfaced per card
 * via the new `groupChip` prop so the user can eyeball "ah, it's in the
 * Backkurs-Crew" without opening the recipe.
 *
 * The URL is the source of truth for query / sort / page — typing
 * commits after a 300 ms debounce so keystrokes don't slam the backend.
 * An empty `q` short-circuits into a prompt state and never fetches (the
 * hook gates on `q.length >= 1`).
 *
 * Sort enum mirrors the SEARCH-0 backend exactly:
 *   relevance_desc (default when q set) | updated_desc | cooked_desc
 *   | title_asc | rating_desc
 *
 * PAGE-1's `cook_count_desc` is deliberately not offered — the column
 * isn't indexed on the join side and the design doc keeps the cut.
 */
const SORT_OPTIONS: Array<{ value: GlobalSearchSort; label: string }> = [
  { value: 'relevance_desc', label: 'Relevanz' },
  { value: 'updated_desc', label: 'Zuletzt aktualisiert' },
  { value: 'cooked_desc', label: 'Zuletzt gekocht' },
  { value: 'title_asc', label: 'Titel A-Z' },
  { value: 'rating_desc', label: 'Beste Bewertung' },
]

function parseSort(raw: string | null): GlobalSearchSort {
  if (
    raw === 'relevance_desc' ||
    raw === 'updated_desc' ||
    raw === 'cooked_desc' ||
    raw === 'title_asc' ||
    raw === 'rating_desc'
  ) {
    return raw
  }
  return DEFAULT_GLOBAL_SEARCH_SORT
}

export function SearchPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const urlQ = searchParams.get('q') ?? ''
  const urlSort = parseSort(searchParams.get('sort'))
  const urlPageRaw = Number(searchParams.get('page'))
  const urlPage = Number.isFinite(urlPageRaw) && urlPageRaw >= 1 ? urlPageRaw : 1

  // Local input state seeds from the URL on mount so a deep-link
  // `?q=foo` lands with `foo` already in the box. Thereafter, typing
  // drives the input immediately (for crisp feedback) and a 300 ms
  // debounce commits the trimmed value back to `?q=…` with
  // `replace: true` so the back-button doesn't walk every keystroke.
  // Once the user has typed, we deliberately do NOT re-seed from the
  // URL — that would fight the debounce mid-stream. Programmatic
  // resets (clear-button, sort-change) update `input` explicitly.
  const [input, setInput] = useState(urlQ)
  const [hasUserTyped, setHasUserTyped] = useState(false)

  useEffect(() => {
    if (!hasUserTyped) return
    const handle = setTimeout(() => {
      const trimmed = input.trim()
      const next = new URLSearchParams(searchParams)
      if (trimmed.length === 0) {
        next.delete('q')
      } else {
        next.set('q', trimmed)
      }
      // Typing a new term resets pagination.
      next.delete('page')
      if (next.toString() !== searchParams.toString()) {
        setSearchParams(next, { replace: true })
      }
    }, 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only input/hasUserTyped drive the debounce
  }, [input, hasUserTyped])

  const handleInputChange = useCallback((next: string) => {
    setHasUserTyped(true)
    setInput(next)
  }, [])

  const handleClear = useCallback(() => {
    setHasUserTyped(true)
    setInput('')
    const next = new URLSearchParams(searchParams)
    next.delete('q')
    next.delete('page')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const handleSortChange = useCallback(
    (next: GlobalSearchSort) => {
      const params = new URLSearchParams(searchParams)
      if (next === DEFAULT_GLOBAL_SEARCH_SORT) {
        params.delete('sort')
      } else {
        params.set('sort', next)
      }
      // Changing sort resets the page so a deep `?page=5&sort=X` swap
      // doesn't strand the user on an empty tail page.
      params.delete('page')
      setSearchParams(params)
    },
    [searchParams, setSearchParams],
  )

  const handlePageChange = useCallback(
    (nextPage: number) => {
      const params = new URLSearchParams(searchParams)
      if (nextPage <= 1) {
        params.delete('page')
      } else {
        params.set('page', String(nextPage))
      }
      setSearchParams(params)
    },
    [searchParams, setSearchParams],
  )

  const trimmedQ = urlQ.trim()
  const search = useRecipeGlobalSearch(trimmedQ, {
    page: urlPage,
    pageSize: DEFAULT_GLOBAL_SEARCH_PAGE_SIZE,
    sort: urlSort,
  })

  const items = search.data?.items ?? []
  const total = search.data?.total ?? 0
  const hasQuery = trimmedQ.length >= 1
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_GLOBAL_SEARCH_PAGE_SIZE))

  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 pb-8 pt-4 md:px-6">
      {/* Sticky header — input + clear + sort. Hoisted into its own
          sticky band so scrolling the grid keeps the search bar visible. */}
      <div
        className={cn(
          'sticky top-0 z-10 -mx-4 mb-4 flex flex-col gap-2 border-b border-border/60 bg-background/90 px-4 py-3 backdrop-blur',
          'md:-mx-6 md:px-6',
        )}
      >
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            {/* autoFocus lands the cursor in the input on mount so the
                user can start typing the moment the route resolves. */}
            <Input
              autoFocus
              type="search"
              placeholder="Rezept suchen"
              aria-label="Rezept suchen"
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              className="pr-10"
            />
            {input.length > 0 && (
              <button
                type="button"
                onClick={handleClear}
                aria-label={t('common.clearSearch', {
                  defaultValue: 'Suchbegriff löschen',
                })}
                className="absolute right-1 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
          {hasQuery && (
            <label className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
              <span className="sr-only">Sortierung</span>
              <Select
                aria-label="Sortierung"
                value={urlSort}
                onChange={(e) => handleSortChange(e.target.value as GlobalSearchSort)}
                className="h-11 w-auto min-w-[160px] text-sm"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
      </div>

      {/* Body. Three mutually exclusive branches: no-query prompt,
          loading skeletons, results grid / empty-results. */}
      {!hasQuery && (
        <div className="rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 px-6 py-10 text-center">
          <p className="font-serif text-[22px] font-semibold text-foreground">
            Rezepte suchen
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Tippe einen Suchbegriff ein, um Rezepte aus all deinen Gruppen zu finden.
          </p>
        </div>
      )}

      {hasQuery && search.isLoading && (
        <div
          aria-label="Rezepte werden gesucht"
          className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-4"
        >
          {Array.from({ length: DEFAULT_GLOBAL_SEARCH_PAGE_SIZE }, (_, i) => (
            <div
              key={i}
              data-testid="search-skeleton-card"
              role="status"
              className="aspect-[4/3] animate-pulse rounded-[18px] bg-muted"
            />
          ))}
        </div>
      )}

      {hasQuery && search.isError && (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
        >
          Rezepte konnten nicht geladen werden.
        </p>
      )}

      {hasQuery && search.isSuccess && items.length === 0 && (
        <div className="rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 px-6 py-10 text-center">
          <p className="font-serif text-[22px] font-semibold text-foreground">
            Kein Treffer
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Keine Treffer für „{trimmedQ}" in deinen Gruppen.
          </p>
        </div>
      )}

      {hasQuery && search.isSuccess && items.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-4">
            {items.map((item) => (
              <RecipeGridCard
                key={item.id}
                recipe={item}
                tags={[]}
                prepTimeMinutes={null}
                groupChip={{ id: item.groupId, name: item.groupName }}
              />
            ))}
          </div>
          <Pagination
            page={urlPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
          />
        </>
      )}
    </main>
  )
}
