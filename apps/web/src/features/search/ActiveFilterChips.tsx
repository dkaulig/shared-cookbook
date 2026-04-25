import { X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import type { TagDto } from '@shared-cookbook/shared'
import { useGroupTags } from '@/features/recipes/hooks'
import { useGroupMembers } from '@/features/groups/hooks'
import { readFiltersFromSearchParams, writeFiltersToSearchParams } from './urlState'

/**
 * Extracted active-filter chip row used by `<GroupDetailPage />`.
 *
 * The row renders one chip per active filter (tag, min-rating, max-prep,
 * creator) with an × remove button, plus a "Filter zurücksetzen"
 * link-button that wipes every filter at once.
 *
 * Shown both above the expanded `<RecipeFilterPanel />` AND as a
 * standalone row when the panel is collapsed, so the user always has
 * visibility + quick removal of active filters regardless of panel
 * state.
 */
export function ActiveFilterChips({ groupId }: { groupId: string }) {
  const [params, setParams] = useSearchParams()
  const tagsQuery = useGroupTags(groupId)
  const membersQuery = useGroupMembers(groupId)
  const filters = readFiltersFromSearchParams(params)

  function update(partial: Record<string, unknown>): void {
    const next = { ...filters, ...partial }
    setParams(writeFiltersToSearchParams(next as never), { replace: true })
  }

  function removeTag(id: string) {
    const current = filters.tags ?? []
    const nextTags = current.filter((t) => t !== id)
    update({ tags: nextTags.length === 0 ? undefined : nextTags })
  }

  function clearAll() {
    setParams(
      writeFiltersToSearchParams(filters.q ? { q: filters.q } : {}),
      { replace: true },
    )
  }

  const chips: { key: string; label: string; remove: () => void }[] = []
  const tagPool: TagDto[] = tagsQuery.data ?? []
  for (const tagId of filters.tags ?? []) {
    const tag = tagPool.find((t) => t.id === tagId)
    if (!tag) continue
    chips.push({
      key: `tag-${tagId}`,
      label: tag.name,
      remove: () => removeTag(tagId),
    })
  }
  if (filters.minRating != null) {
    chips.push({
      key: 'min-rating',
      label: `≥ ${filters.minRating} Sterne`,
      remove: () => update({ minRating: undefined }),
    })
  }
  if (filters.maxPrepTime != null) {
    chips.push({
      key: 'max-prep',
      label: `≤ ${filters.maxPrepTime} Min`,
      remove: () => update({ maxPrepTime: undefined }),
    })
  }
  if (filters.createdBy) {
    const member = (membersQuery.data ?? []).find((m) => m.userId === filters.createdBy)
    if (member) {
      chips.push({
        key: `by-${filters.createdBy}`,
        label: `von ${member.displayName}`,
        remove: () => update({ createdBy: undefined }),
      })
    }
  }

  if (chips.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1.5 rounded-full bg-[hsl(var(--primary)/0.08)] px-2.5 py-1 pl-[11px] text-[13px] font-medium text-primary"
        >
          {chip.label}
          <button
            type="button"
            aria-label={`${chip.label} entfernen`}
            onClick={chip.remove}
            className="grid place-items-center opacity-80 hover:opacity-100"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={clearAll}
        className="px-2 py-1 text-[13px] text-[hsl(var(--muted-foreground))] hover:text-destructive"
      >
        Filter zurücksetzen
      </button>
    </div>
  )
}
