import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Star } from 'lucide-react'
import type {
  RecipeSearchParams,
  SearchSort,
  TagCategory,
  TagDto,
} from '@familien-kochbuch/shared'
import { cn } from '@/lib/utils'
import { useGroupTags } from '@/features/recipes/hooks'
import { useGroupMembers } from '@/features/groups/hooks'
import { CreateTagDialog } from '@/features/tagManagement/CreateTagDialog'
import { readFiltersFromSearchParams, writeFiltersToSearchParams } from './urlState'
import { usePresetConsumer } from './usePresetConsumer'

/**
 * DS4 Recipe-filter panel.
 *
 * Mirrors `.filter-panel` + `.active-filters` sections of
 * `docs/mockups/warme-kueche-group-detail.html`:
 *   1. Active-filter chips row (above the panel) — shows every applied
 *      filter with a × remove button plus "Filter zurücksetzen".
 *   2. Tag groups — one sub-row per category, chips toggle selection.
 *      A dashed "Eigenen Tag erstellen" button opens the existing
 *      CreateTagDialog in the Custom row.
 *   3. Min-rating range slider (0–5).
 *   4. Max-prep-time range slider (10–240 min).
 *   5. Creator + sort dropdowns on a shared row.
 *
 * Filter state round-trips through URL search params
 * (`?q=…&tags=…&minRating=…&…`). The component consumes a `?preset=`
 * param once on entry — maps it to concrete filters via
 * `applyFilterPreset`, then clears the param so refresh/back doesn't
 * re-apply.
 *
 * Zufall (random pick) has moved up to `<GroupFilterBar />` at the page
 * level in DS4; this panel is now filter-only.
 */
const CATEGORY_ORDER: readonly TagCategory[] = [
  'Mahlzeit',
  'Saison',
  'Typ',
  'Aufwand',
  'Diaet',
  'Kueche',
  // GR1 — isolated sub-recipes (Pizzateig, Tomatensauce, Dressings, …).
  // Placed before Custom so the predefined categories stay grouped and
  // the user-created tags remain visually distinct at the bottom.
  'Komponente',
  'Custom',
]

const CATEGORY_LABEL: Record<TagCategory, string> = {
  Mahlzeit: 'Mahlzeit',
  Saison: 'Saison',
  Typ: 'Typ',
  Aufwand: 'Aufwand',
  Diaet: 'Diät',
  Kueche: 'Küche',
  Komponente: 'Komponente',
  Custom: 'Custom',
}

/**
 * Filter-panel sort labels. Kept narrow (the 3 search-endpoint values)
 * so the panel's sort dropdown only surfaces the sorts the filter panel
 * supports; PAGE-1 added new list-endpoint sort values that live on the
 * GroupDetailPage header Select instead.
 */
const SORT_LABELS: Partial<Record<SearchSort, string>> = {
  newest: 'Neueste',
  best_rated: 'Am besten bewertet',
  last_cooked: 'Zuletzt gekocht',
}

export function RecipeFilterPanel({ groupId }: { groupId: string }) {
  const [params, setParams] = useSearchParams()
  const tagsQuery = useGroupTags(groupId)
  const membersQuery = useGroupMembers(groupId)

  const filters = readFiltersFromSearchParams(params)
  const [showCreateTag, setShowCreateTag] = useState(false)

  // Presets are consumed at the GroupDetailPage level (so they fire
  // even when the panel is still collapsed), but keeping the hook
  // wired up here too is a safety net for standalone panel usage.
  usePresetConsumer({
    tags: tagsQuery.data,
    tagsReady: tagsQuery.isSuccess,
    onRandomRequest: () => undefined,
  })

  function update(partial: Partial<RecipeSearchParams>) {
    const merged = { ...filters, ...partial }
    setParams(writeFiltersToSearchParams(merged), { replace: true })
  }

  function toggleTag(id: string) {
    const current = filters.tags ?? []
    const next = current.includes(id) ? current.filter((t) => t !== id) : [...current, id]
    update({ tags: next.length === 0 ? undefined : next })
  }

  // Live filter for the tag chip grid — keeps the panel manageable once
  // a group has many tags. Selected chips always stay visible so the
  // user can see + toggle their current selection even while typing.
  const [tagQuery, setTagQuery] = useState('')

  const selectedTagIds = new Set(filters.tags ?? [])

  // Plain per-render compute — at realistic tag counts (≤100) the cost
  // is trivial and the React-compiler bails out on a memo wrapper here
  // because `filters.tags` is a fresh array per render.
  const tagsByCategory = (() => {
    const normalised = tagQuery.trim().toLowerCase()
    const map = new Map<TagCategory, TagDto[]>()
    for (const tag of tagsQuery.data ?? []) {
      const matchesQuery =
        normalised === '' || tag.name.toLowerCase().includes(normalised)
      const isSelected = selectedTagIds.has(tag.id)
      if (!matchesQuery && !isSelected) continue
      if (!map.has(tag.category)) map.set(tag.category, [])
      map.get(tag.category)!.push(tag)
    }
    return map
  })()

  return (
    <div className="space-y-3">
      {/* Expanded filter panel */}
      <section
        className={cn(
          'space-y-[18px] rounded-[18px] border border-border bg-card p-5 pb-[18px]',
          'shadow-[0_1px_2px_rgba(28,25,23,0.04)]',
        )}
      >
        {/* Tag groups */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-[hsl(var(--muted-foreground))]">
              Tags
            </span>
            {selectedTagIds.size > 0 && (
              <span className="text-[12px] font-semibold text-primary">
                {selectedTagIds.size} ausgewählt
              </span>
            )}
          </div>

          {tagsQuery.isLoading ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Lade Tags …</p>
          ) : (
            <div className="space-y-2.5">
              <input
                type="text"
                aria-label="Tag suchen"
                placeholder="Tag suchen"
                value={tagQuery}
                onChange={(e) => setTagQuery(e.target.value)}
                className="w-full rounded-[10px] border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-[13px] placeholder:text-[hsl(var(--muted-foreground))] focus:border-primary focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/0.25)]"
              />
              {CATEGORY_ORDER.filter((c) => tagsByCategory.has(c)).map((category) => (
                <div key={category}>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-[hsl(var(--muted-foreground))]">
                    {CATEGORY_LABEL[category]}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(tagsByCategory.get(category) ?? []).map((tag) => {
                      const selected = selectedTagIds.has(tag.id)
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => toggleTag(tag.id)}
                          aria-pressed={selected}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2.5 py-[5px] text-[13px] transition-colors',
                            selected
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-[hsl(var(--input))] bg-transparent text-[hsl(var(--muted-foreground))] hover:border-primary hover:text-primary',
                          )}
                        >
                          {tag.name}
                        </button>
                      )
                    })}
                    {category === 'Custom' && (
                      <button
                        type="button"
                        onClick={() => setShowCreateTag(true)}
                        className="inline-flex items-center gap-1 rounded-full border border-dashed border-[hsl(var(--input))] bg-transparent px-2.5 py-[5px] text-[13px] text-[hsl(var(--muted-foreground))] transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary"
                      >
                        <Plus className="h-3 w-3" aria-hidden="true" />
                        Eigenen Tag erstellen
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {!tagsByCategory.has('Custom') && (
                <div>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-[hsl(var(--muted-foreground))]">
                    Custom
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowCreateTag(true)}
                    className="inline-flex items-center gap-1 rounded-full border border-dashed border-[hsl(var(--input))] bg-transparent px-2.5 py-[5px] text-[13px] text-[hsl(var(--muted-foreground))] transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary"
                  >
                    <Plus className="h-3 w-3" aria-hidden="true" />
                    Eigenen Tag erstellen
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Min rating */}
        <FilterGroupDivider>
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-[hsl(var(--muted-foreground))]">
              Mindest-Bewertung
            </span>
            <span className="text-[12px] font-semibold text-primary">
              {filters.minRating ? `ab ${filters.minRating} Sternen` : 'egal'}
            </span>
          </div>
          <div className="mt-2.5 flex items-center gap-2.5">
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
              aria-label="Mindest-Bewertung"
              className="h-[3px] flex-1 rounded-full bg-[hsl(var(--input))] accent-primary"
            />
            <span className="inline-flex items-center gap-[3px] font-bold text-[hsl(var(--star,38_92%_44%))]">
              <Star className="h-4 w-4 fill-current" style={{ color: '#d97706' }} aria-hidden="true" />
              <span style={{ color: '#d97706' }}>{filters.minRating ?? 0}</span>
            </span>
          </div>
        </FilterGroupDivider>

        {/* Max prep time */}
        <FilterGroupDivider>
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-[hsl(var(--muted-foreground))]">
              Maximale Zubereitung
            </span>
            <span className="text-[12px] font-semibold text-primary">
              {filters.maxPrepTime ? `bis ${filters.maxPrepTime} Min` : 'egal'}
            </span>
          </div>
          <div className="mt-2.5 flex items-center gap-2.5">
            <input
              id="max-prep"
              type="range"
              min={10}
              max={240}
              step={5}
              value={filters.maxPrepTime ?? 10}
              onChange={(e) => {
                const n = Number(e.target.value)
                update({ maxPrepTime: n <= 10 ? undefined : n })
              }}
              aria-label="Maximale Zubereitung"
              className="h-[3px] flex-1 rounded-full bg-[hsl(var(--input))] accent-primary"
            />
            <span className="min-w-[50px] text-right text-sm font-bold tabular-nums text-foreground">
              {filters.maxPrepTime ? `${filters.maxPrepTime} Min` : '—'}
            </span>
          </div>
        </FilterGroupDivider>

        {/* Creator + Sort */}
        <FilterGroupDivider>
          <div className="text-[12px] font-bold uppercase tracking-[0.06em] text-[hsl(var(--muted-foreground))]">
            Ersteller &amp; Sortierung
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2.5">
            <label className="sr-only" htmlFor="creator">Ersteller</label>
            <select
              id="creator"
              aria-label="Ersteller"
              value={filters.createdBy ?? ''}
              onChange={(e) => update({ createdBy: e.target.value === '' ? undefined : e.target.value })}
              className="rounded-[10px] border border-[hsl(var(--input))] bg-background px-3.5 py-2.5 pr-8 text-sm text-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[hsl(var(--primary)/0.25)]"
            >
              <option value="">Alle Mitglieder</option>
              {(membersQuery.data ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
            </select>

            <label className="sr-only" htmlFor="sort">Sortierung</label>
            <select
              id="sort"
              aria-label="Sortierung"
              value={filters.sort ?? 'newest'}
              onChange={(e) => update({ sort: e.target.value as SearchSort })}
              className="rounded-[10px] border border-[hsl(var(--input))] bg-background px-3.5 py-2.5 pr-8 text-sm text-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[hsl(var(--primary)/0.25)]"
            >
              {(Object.entries(SORT_LABELS) as [SearchSort, string][]).map(([value, label]) => (
                <option key={value} value={value}>
                  {value === 'newest' ? 'Sortieren: Neueste' : label}
                </option>
              ))}
            </select>
          </div>
        </FilterGroupDivider>
      </section>

      {showCreateTag && (
        <CreateTagDialog groupId={groupId} onClose={() => setShowCreateTag(false)} />
      )}
    </div>
  )
}

function FilterGroupDivider({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-dashed border-border pt-[18px]">
      {children}
    </div>
  )
}

