import { GitFork } from 'lucide-react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'

export interface RecipeForkBannerProps {
  /** Id of the original (source) recipe the link points to. */
  originalRecipeId: string
  /** Display title of the original recipe — used as link copy. */
  originalRecipeTitle: string
  /**
   * Name of the group the original lives in, or `null` when the current
   * user can't see the source group (membership lookup returned nothing).
   * The "Gruppe <name>" suffix is omitted in that case.
   */
  sourceGroupName: string | null
  /** Additional classes for the outer wrapper (for parent-driven spacing). */
  className?: string
}

/**
 * DS5 fork-attribution banner rendered inside the recipe title card when
 * the recipe is a fork (`recipe.forkOfRecipeId != null`).
 *
 * Visual shell mirrors `.fork-banner` in
 * `docs/mockups/warme-kueche-recipe-detail.html`:
 *   - amber-tinted surface (`bg-[hsl(var(--secondary))]`)
 *   - 28×28 git-fork icon on the left
 *   - "Geforkt aus „{Title}" · Gruppe {Name}" on the right, with the
 *     title rendered as a link back to the original recipe.
 *
 * The link resolves to `/recipes/{id}`. If the current user isn't a
 * member of the source group, that route returns 403 — acceptable per
 * PRD §4.7; the detail page shows a friendly "kein Zugriff" fallback.
 */
export function RecipeForkBanner({
  originalRecipeId,
  originalRecipeTitle,
  sourceGroupName,
  className,
}: RecipeForkBannerProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-[12px] border border-[hsl(48_96%_80%)]',
        'bg-[hsl(var(--secondary))] px-3.5 py-2.5 text-[13px] leading-snug text-[hsl(var(--foreground))]',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="grid h-7 w-7 flex-shrink-0 place-items-center text-[hsl(var(--primary-hover,var(--primary)))]"
      >
        <GitFork className="h-4 w-4" strokeWidth={2} />
      </span>
      <div>
        Geforkt aus{' '}
        <Link
          to={`/recipes/${originalRecipeId}`}
          className="font-semibold text-[hsl(var(--primary))] hover:underline"
          title="Zum Original (Zugriff hängt von Gruppenmitgliedschaft ab)"
        >
          „{originalRecipeTitle}"
        </Link>
        {sourceGroupName != null && (
          <>
            {' '}
            · Gruppe <strong className="font-semibold">{sourceGroupName}</strong>
          </>
        )}
      </div>
    </div>
  )
}
