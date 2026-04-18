import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ApiError, RecipeSearchParams, SearchSort } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useGroupTags } from '@/features/recipes/hooks'
import { useGroupMembers } from '@/features/groups/hooks'
import { fetchRandomRecipe } from './searchApi'
import { readFiltersFromSearchParams, writeFiltersToSearchParams } from './urlState'

const CATEGORY_ORDER = ['Mahlzeit', 'Saison', 'Typ', 'Aufwand', 'Diaet', 'Kueche', 'Custom'] as const

const SORT_LABELS: Record<SearchSort, string> = {
  newest: 'Neueste',
  best_rated: 'Am besten bewertet',
  last_cooked: 'Zuletzt gekocht',
}

/**
 * Filter sidebar/panel used on top of the recipe list. Persists every
 * filter change into URL search-params (`?q=…&tags=…&…`) so the UI is
 * shareable and survives reload. Also hosts the "Zufall"-Button that
 * picks a random recipe matching the current filter set.
 */
export function RecipeFilterPanel({ groupId }: { groupId: string }) {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const tagsQuery = useGroupTags(groupId)
  const membersQuery = useGroupMembers(groupId)

  const filters = readFiltersFromSearchParams(params)

  // Debounce the text search so typing "Nudeln" doesn't slam the URL six
  // times in a row. 300 ms per PRD brief. The visible value tracks input
  // eagerly; the URL lags.
  const [qInput, setQInput] = useState(filters.q ?? '')
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = { ...filters, q: qInput.trim() === '' ? undefined : qInput }
      const nextParams = writeFiltersToSearchParams(next)
      if (nextParams.toString() !== params.toString()) {
        setParams(nextParams, { replace: true })
      }
    }, 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only qInput drives the debounce
  }, [qInput])

  const [randomError, setRandomError] = useState<string | null>(null)
  const [randomPending, setRandomPending] = useState(false)

  function update(partial: Partial<RecipeSearchParams>) {
    const merged = { ...filters, ...partial }
    setParams(writeFiltersToSearchParams(merged), { replace: true })
  }

  function toggleTag(id: string) {
    const current = filters.tags ?? []
    const next = current.includes(id) ? current.filter((t) => t !== id) : [...current, id]
    update({ tags: next.length === 0 ? undefined : next })
  }

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

  const tagsByCategory = new Map<string, typeof tagsQuery.data>()
  for (const tag of tagsQuery.data ?? []) {
    if (!tagsByCategory.has(tag.category)) tagsByCategory.set(tag.category, [])
    tagsByCategory.get(tag.category)!.push(tag)
  }

  return (
    <section className="space-y-4 rounded-md bg-background p-4 ring-1 ring-border">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-stone-900">Filter</h2>
        <Button type="button" onClick={handleRandom} disabled={randomPending}>
          {randomPending ? 'Würfle…' : 'Zufall'}
        </Button>
      </div>

      {randomError && (
        <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          {randomError}
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="recipe-search">Suche</Label>
        <Input
          id="recipe-search"
          type="search"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Titel, Zutat, Beschreibung"
        />
      </div>

      <div className="space-y-2">
        <Label>Tags</Label>
        {tagsQuery.isLoading ? (
          <p className="text-xs text-stone-500">Lade Tags …</p>
        ) : (
          <div className="space-y-2">
            {CATEGORY_ORDER.filter((c) => tagsByCategory.has(c)).map((category) => (
              <div key={category}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
                  {category}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {(tagsByCategory.get(category) ?? []).map((tag) => {
                    const selected = (filters.tags ?? []).includes(tag.id)
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() => toggleTag(tag.id)}
                        aria-pressed={selected}
                        className={
                          'rounded-full border px-3 py-1 text-xs transition-colors ' +
                          (selected
                            ? 'border-stone-900 bg-stone-900 text-white'
                            : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-100')
                        }
                      >
                        {tag.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="min-rating">Mindest-Sterne</Label>
          <input
            id="min-rating"
            type="range"
            min={0}
            max={5}
            step={1}
            value={filters.minRating ?? 0}
            onChange={(e) => {
              const n = Number(e.target.value)
              update({ minRating: n === 0 ? undefined : n })
            }}
            className="w-full"
          />
          <p className="text-xs text-stone-500">
            {filters.minRating ? `${filters.minRating}+ Sterne` : 'Kein Filter'}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="max-prep">Max. Zeit (Min.)</Label>
          <input
            id="max-prep"
            type="range"
            min={0}
            max={240}
            step={5}
            value={filters.maxPrepTime ?? 0}
            onChange={(e) => {
              const n = Number(e.target.value)
              update({ maxPrepTime: n === 0 ? undefined : n })
            }}
            className="w-full"
          />
          <p className="text-xs text-stone-500">
            {filters.maxPrepTime ? `≤ ${filters.maxPrepTime} Min.` : 'Kein Filter'}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="creator">Ersteller</Label>
          <select
            id="creator"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            value={filters.createdBy ?? ''}
            onChange={(e) => update({ createdBy: e.target.value === '' ? undefined : e.target.value })}
          >
            <option value="">Alle</option>
            {(membersQuery.data ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sort">Sortierung</Label>
        <select
          id="sort"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
          value={filters.sort ?? 'newest'}
          onChange={(e) => update({ sort: e.target.value as SearchSort })}
        >
          {(Object.entries(SORT_LABELS) as [SearchSort, string][]).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
    </section>
  )
}
