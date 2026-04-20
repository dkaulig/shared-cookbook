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
 * DS5 contextual action bar for the recipe detail page. Mirrors
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
 * BUG-036 — previously rendered with its own `fixed bottom-[calc(--
 * bottom-nav-height…)]` wrapper. Now renders as a plain 2-button row;
 * positioning is handled by the Bottom-Zone slot inside BottomNav
 * (`useBottomZoneSlot(<RecipeActionBar … />)` in `RecipeDetailPage`).
 *
 * The transient success / error notifier stays as a short-lived fixed
 * overlay above the Bottom-Zone (z-50 so it clears BottomNav's z-30
 * without colliding with shadcn dialogs at z-50+; dialogs trap focus,
 * this toast does not, so the tie is visually acceptable). One-two-
 * second flash; no layout claim on the content area.
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
      <button
        type="button"
        onClick={handleWochenplanClick}
        className={cn(
          'flex-1 inline-flex items-center justify-center gap-2 rounded-[12px] border border-[hsl(var(--input))] bg-card px-4 py-[11px] text-[15px] font-semibold text-foreground',
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
          'inline-flex items-center justify-center gap-2 rounded-[12px] border border-[hsl(var(--primary))] bg-[hsl(var(--primary))] px-4 py-[11px] text-[15px] font-semibold text-[hsl(var(--primary-foreground))]',
          'shadow-[0_4px_12px_-4px_rgba(180,83,9,0.45)] transition-colors hover:bg-[hsl(var(--primary-hover,var(--primary)))] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60',
          'flex-[1.3]',
        )}
      >
        <Check className="h-[18px] w-[18px]" strokeWidth={2.4} aria-hidden="true" />
        {markCookedPending ? 'Speichere…' : 'Jetzt gekocht'}
      </button>

      {/* Lightweight inline notifier — avoids pulling in a toast library.
          aria-live on the wrapper keeps SR users informed; sighted users
          see the short message above the Bottom-Zone. The notifier is
          a separate fixed overlay because it's transient (1-2 s) and
          shouldn't push the nav row up/down. z-50 clears BottomNav
          (z-30) and matches the dialog layer without the focus-trap
          behaviour. */}
      <div className="sr-only" aria-live="polite">
        {status}
      </div>
      <div className="sr-only" aria-live="assertive">
        {error}
      </div>
      {(status || error) && (
        <div
          className={cn(
            'pointer-events-none fixed inset-x-0 z-50 flex justify-center px-3',
            // Track the rendered BottomNav height + visual-viewport
            // offset so the toast floats just above the unified Bottom-
            // Zone without its own positioning math per row count.
            'bottom-[calc(var(--bottom-nav-height)+env(safe-area-inset-bottom,0px)+var(--viewport-bottom-offset,0px)+12px)]',
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
