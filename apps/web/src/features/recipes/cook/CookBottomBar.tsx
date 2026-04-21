import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface CookBottomBarProps {
  /** True when the back button should be disabled (e.g. first step). */
  backDisabled: boolean
  /** True when the next button should be disabled. */
  nextDisabled?: boolean
  /** Primary label for the "next" action — normally "Weiter", "Fertig" on the last step. */
  nextLabel: string
  /**
   * True when the next button represents the final step transition and
   * should render the done-check variant instead of the arrow.
   */
  nextIsFinish: boolean
  onBack: () => void
  onNext: () => void
}

/**
 * COOK-0 bottom nav — two-button row: back + primary next/finish.
 * Sticky at the bottom edge of the cook page (inside the dedicated
 * cook layout, not the normal BottomNav). Big 56 px tap targets so
 * the user can operate it with flour-dusted fingertips.
 */
export function CookBottomBar({
  backDisabled,
  nextDisabled = false,
  nextLabel,
  nextIsFinish,
  onBack,
  onNext,
}: CookBottomBarProps) {
  return (
    <footer
      data-testid="cook-bottom-bar"
      className="sticky bottom-0 z-10 flex w-full items-stretch gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur-sm pb-safe md:px-6"
    >
      <button
        type="button"
        onClick={onBack}
        disabled={backDisabled}
        className={cn(
          'inline-flex min-h-[56px] flex-1 items-center justify-center gap-2 rounded-[14px] border border-[hsl(var(--input))] bg-card px-4 text-[17px] font-semibold text-foreground',
          'transition-colors hover:border-[hsl(var(--primary))] hover:text-[hsl(var(--primary))] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[hsl(var(--input))] disabled:hover:text-foreground',
        )}
      >
        <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        Zurück
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className={cn(
          'inline-flex min-h-[56px] items-center justify-center gap-2 rounded-[14px] bg-[hsl(var(--primary))] px-6 text-[17px] font-semibold text-[hsl(var(--primary-foreground))]',
          'shadow-[0_4px_12px_-4px_rgba(180,83,9,0.45)] transition-colors hover:bg-[hsl(var(--primary-hover,var(--primary)))] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60',
          'flex-[1.4]',
        )}
      >
        {nextLabel}
        {nextIsFinish ? (
          <Check className="h-5 w-5" strokeWidth={2.4} aria-hidden="true" />
        ) : (
          <ArrowRight className="h-5 w-5" aria-hidden="true" />
        )}
      </button>
    </footer>
  )
}
