import { Star } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { RecipeSummaryDto, TagDto } from '@familien-kochbuch/shared'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { recipePhotoGradient } from './recipePhotoGradient'

/**
 * DS4 compact recipe card for the Group-Detail grid (retinted for DS8
 * Sage Modern).
 *
 * Mirrors `.recipe-card` in the mockup:
 *   - 4 : 3 cover (photo URL or hashed gradient placeholder)
 *   - rating pill overlay (top-right) when avgRating is set
 *   - `font-serif` display title (Inter under DS8)
 *   - meta line: prep minutes · creator display name
 *   - up to 2 mini-tag chips
 *   - SEARCH-1: optional group-chip (Badge linking to /groups/{id})
 *     rendered only on cross-group surfaces like `/suche` where the
 *     owning group is NOT implicit from the URL
 *
 * The tag pool is passed in by the parent (`useGroupTags(groupId)` lives
 * up there) so this card stays pure-render. The summary DTO only carries
 * `tagIds`; we resolve up to two names from the pool.
 */
export interface RecipeGridCardProps {
  recipe: RecipeSummaryDto
  tags: TagDto[]
  /**
   * Prep-time minutes (not on the summary DTO — parent pulls from the
   * full recipe if available; pass `null` to hide the minutes leg).
   */
  prepTimeMinutes: number | null
  /**
   * SEARCH-1 — optional group-chip rendered on cross-group search
   * surfaces. When set, a small Badge sits ABOVE the card body linking
   * to `/groups/{id}`. Omit on per-group pages (where every card
   * belongs to the same group and the chip is visual noise).
   */
  groupChip?: { id: string; name: string }
}

export function RecipeGridCard({
  recipe,
  tags,
  prepTimeMinutes,
  groupChip,
}: RecipeGridCardProps) {
  const rating =
    recipe.avgRating != null
      ? recipe.avgRating.toFixed(1).replace('.', ',')
      : null

  const backgroundImage = recipe.photo
    ? `url(${recipe.photo})`
    : recipePhotoGradient(recipe.id)

  const resolvedTags = recipe.tagIds
    .map((id) => tags.find((t) => t.id === id))
    .filter((t): t is TagDto => t != null)
    .slice(0, 2)

  // SEARCH-1 — when a `groupChip` is set we need the chip to be its own
  // <Link to="/groups/{id}"> AND the card body to remain a <Link to=".../
  // recipes/{id}">. Nested <a> tags are invalid HTML, so we wrap both in
  // a plain <article> and keep each as a sibling link. The card body
  // takes up the full visual area; the chip floats on top of the photo
  // corner so it doesn't intercept taps on the main target.
  const body = (
    <Link
      to={`/groups/${recipe.groupId}/recipes/${recipe.id}`}
      aria-label={recipe.title}
      className={cn(
        'group flex flex-col overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_1px_2px_rgba(28,25,23,0.04)]',
        'transition hover:-translate-y-px hover:border-[hsl(var(--input))] hover:shadow-[0_8px_24px_-8px_rgba(79,121,97,0.18),0_2px_6px_-2px_rgba(28,25,23,0.04)]',
      )}
    >
      <div
        data-testid="recipe-photo"
        aria-hidden="true"
        className="relative aspect-[4/3] bg-cover bg-center"
        style={{ backgroundImage }}
      >
        {rating && (
          <span
            className={cn(
              'absolute right-2 top-2 inline-flex items-center gap-[3px] rounded-full px-2 py-[3px]',
              'bg-[rgba(26,26,24,0.82)] text-[11px] font-semibold text-[#fafafa] backdrop-blur',
            )}
          >
            <Star className="h-[10px] w-[10px] fill-current" aria-hidden="true" />
            {rating}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 px-3 pb-3 pt-2.5">
        <div className="font-serif text-[17px] font-semibold leading-[1.15] tracking-[-0.005em]">
          {recipe.title}
        </div>
        <div className="flex flex-wrap gap-1.5 text-[12px] text-[hsl(var(--muted-foreground))]">
          {prepTimeMinutes != null && <span>{prepTimeMinutes} Min</span>}
          {prepTimeMinutes != null && recipe.createdByDisplayName && (
            <span aria-hidden="true" className="text-[hsl(var(--input))]">·</span>
          )}
          {recipe.createdByDisplayName && (
            <span>{recipe.createdByDisplayName}</span>
          )}
        </div>
        {resolvedTags.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {resolvedTags.map((tag) => (
              <span
                key={tag.id}
                className="rounded-[4px] bg-[hsl(var(--primary)/0.1)] px-1.5 py-[1px] text-[10.5px] font-medium text-primary"
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  )

  if (!groupChip) return body

  return (
    <article className="relative">
      {body}
      <Link
        to={`/groups/${groupChip.id}`}
        aria-label={groupChip.name}
        title={groupChip.name}
        className={cn(
          // Float over the top-left corner of the photo so the chip
          // reads as a contextual label without eating into the card
          // body's tap target.
          'absolute left-2 top-2 z-10 max-w-[70%] truncate rounded-full backdrop-blur',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        )}
      >
        <Badge
          variant="mini"
          className="max-w-full truncate bg-[rgba(26,26,24,0.82)] text-[11px] text-[#fafafa] hover:bg-[rgba(26,26,24,0.9)]"
        >
          {groupChip.name}
        </Badge>
      </Link>
    </article>
  )
}
