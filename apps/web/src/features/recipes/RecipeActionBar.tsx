import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Calendar, Check } from 'lucide-react'
import type { ApiError } from '@familien-kochbuch/shared'
import { toMondayIso } from '@/features/mealplanning/weekGrid'
import { cn } from '@/lib/utils'

export interface RecipeActionBarProps {
  /**
   * Group the recipe belongs to. Used by the "In Wochenplan" button to
   * navigate the user to that group's Wochenplan for the current week
   * with `?addRecipeId=…` so AddSlotDialog can preselect the recipe.
   */
  groupId: string
  /** Recipe id handed back to the AddSlotDialog via query string. */
  recipeId: string
  /**
   * Fired when the user taps the primary "Jetzt gekocht" button. Should
   * return a Promise so the component can drive its own success /
   * failure toast — the parent only owns the mutation, the bar owns the
   * UX feedback.
   */
  onMarkCooked: () => Promise<unknown>
  /** True while the mark-cooked mutation is in flight. Disables the button. */
  markCookedPending: boolean
}

/**
 * DS5 sticky action bar for the recipe detail page. Mirrors
 * `.actionbar` in `docs/mockups/warme-kueche-recipe-detail.html`:
 *
 *  - Ghost "In Wochenplan" button — navigates to the recipe's group
 *    Wochenplan (current Monday) and hands the recipe id off via
 *    `?addRecipeId=…` so MealPlanPage auto-opens AddSlotDialog with
 *    the recipe preselected. BUG-007 replaced the Phase-3 placeholder
 *    status message with this real navigation.
 *  - Primary amber "Jetzt gekocht" button — fires the parent-provided
 *    mutation, then shows a success status on resolve or an alert on
 *    reject. Disables while pending.
 *
 * Positioning: `fixed bottom-0` with safe-area-inset padding so the bar
 * clears the iOS home indicator. On desktop (`md+`) the BottomNav is
 * hidden, so this bar sits at the viewport bottom directly.
 */
export function RecipeActionBar({
  groupId,
  recipeId,
  onMarkCooked,
  markCookedPending,
}: RecipeActionBarProps) {
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  async function handleCookedClick() {
    setError(null)
    setStatus(null)
    try {
      await onMarkCooked()
      setStatus('Rezept wurde als gekocht markiert.')
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message ?? 'Speichern fehlgeschlagen.')
    }
  }

  function handleWochenplanClick() {
    setError(null)
    setStatus(null)
    const monday = toMondayIso(new Date().toISOString().slice(0, 10))
    navigate(
      `/groups/${groupId}/mealplan/${monday}?addRecipeId=${encodeURIComponent(recipeId)}`,
    )
  }

  return (
    <>
      <div
        className={cn(
          'pointer-events-none fixed inset-x-0 z-[8] flex justify-center px-3',
          // Clear both the BottomNav (only shown on < md) and the iOS home
          // indicator. The BottomNav itself sits fully below this bar at
          // md+ because it is already display:none there.
          'bottom-[calc(env(safe-area-inset-bottom,0px)+72px)] md:bottom-[env(safe-area-inset-bottom,0px)]',
        )}
      >
        <div
          className={cn(
            'pointer-events-auto flex w-full max-w-3xl gap-2.5 rounded-[16px] border border-border bg-background/96 px-3 py-3 backdrop-blur-lg',
            'shadow-[0_-8px_24px_-12px_rgba(28,25,23,0.18)]',
          )}
        >
          <button
            type="button"
            onClick={handleWochenplanClick}
            className={cn(
              'flex-1 inline-flex items-center justify-center gap-2 rounded-[12px] border border-[hsl(var(--input))] bg-card px-4 py-[13px] text-[15px] font-semibold text-foreground',
              'transition-colors hover:border-[hsl(var(--primary))] hover:text-[hsl(var(--primary))] active:scale-[0.99]',
            )}
          >
            <Calendar className="h-[18px] w-[18px]" aria-hidden="true" />
            In Wochenplan
          </button>
          <button
            type="button"
            aria-label="Jetzt gekocht"
            onClick={handleCookedClick}
            disabled={markCookedPending}
            className={cn(
              'inline-flex items-center justify-center gap-2 rounded-[12px] border border-[hsl(var(--primary))] bg-[hsl(var(--primary))] px-4 py-[13px] text-[15px] font-semibold text-[hsl(var(--primary-foreground))]',
              'shadow-[0_4px_12px_-4px_rgba(180,83,9,0.45)] transition-colors hover:bg-[hsl(var(--primary-hover,var(--primary)))] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60',
              'flex-[1.3]',
            )}
          >
            <Check className="h-[18px] w-[18px]" strokeWidth={2.4} aria-hidden="true" />
            {markCookedPending ? 'Speichere…' : 'Jetzt gekocht'}
          </button>
        </div>
      </div>

      {/* Lightweight inline notifier — avoids pulling in a toast library.
          aria-live on the wrapper keeps SR users informed; sighted users
          see the short message at the bottom of the page next to the bar. */}
      <div className="sr-only" aria-live="polite">
        {status}
      </div>
      <div className="sr-only" aria-live="assertive">
        {error}
      </div>
      {(status || error) && (
        <div
          className={cn(
            'pointer-events-none fixed inset-x-0 z-[9] flex justify-center px-3',
            'bottom-[calc(env(safe-area-inset-bottom,0px)+140px)] md:bottom-[calc(env(safe-area-inset-bottom,0px)+80px)]',
          )}
        >
          {status && (
            <div
              role="status"
              className="pointer-events-auto max-w-xs rounded-[12px] bg-[hsl(var(--foreground)/0.92)] px-4 py-2 text-[13px] font-medium text-[hsl(var(--primary-foreground))] shadow-lg"
            >
              {status}
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="pointer-events-auto max-w-xs rounded-[12px] bg-[hsl(var(--destructive))] px-4 py-2 text-[13px] font-medium text-white shadow-lg"
            >
              {error}
            </div>
          )}
        </div>
      )}
    </>
  )
}
