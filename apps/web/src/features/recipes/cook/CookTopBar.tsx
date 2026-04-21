import { Users, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface CookTopBarProps {
  /**
   * Close button handler — the parent typically opens the "beenden?"
   * confirm dialog so unsaved progress isn't lost.
   */
  onClose: () => void
  /**
   * Current step label to display. Use 'Mise en Place' when on step 0,
   * 'Portionen wählen' on step -1, `Schritt X/N` when inside the step
   * navigation, and null/undefined when nothing should render (e.g.
   * finish screen).
   */
  stepLabel: string | null
  /** Session portions — shown as a chip in the top bar. */
  portions: number
  /** Fires when the portions chip is tapped (re-opens the picker). */
  onPortionsClick: () => void
}

/**
 * COOK-0 top chrome — close button + step-progress label + portions
 * chip. Sticky at the top of the viewport. Left-aligned X, centred
 * step label, right-aligned portion chip. 44×44 tap targets.
 */
export function CookTopBar({
  onClose,
  stepLabel,
  portions,
  onPortionsClick,
}: CookTopBarProps) {
  return (
    <header
      data-testid="cook-top-bar"
      className="sticky top-0 z-10 flex w-full items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm"
    >
      <button
        type="button"
        aria-label="Kochmodus schliessen"
        onClick={onClose}
        className={cn(
          'grid h-[44px] w-[44px] place-items-center rounded-full text-[hsl(var(--muted-foreground))]',
          'transition-colors hover:bg-[hsl(var(--secondary))] hover:text-foreground active:scale-95',
        )}
      >
        <X className="h-6 w-6" aria-hidden="true" />
      </button>

      <div
        aria-live="polite"
        data-testid="cook-step-label"
        className="flex-1 text-center text-[15px] font-semibold text-foreground"
      >
        {stepLabel}
      </div>

      <button
        type="button"
        onClick={onPortionsClick}
        aria-label={`Portionen anpassen — aktuell ${portions}`}
        className={cn(
          'inline-flex min-h-[44px] items-center gap-2 rounded-full border border-[hsl(var(--input))] bg-card px-4 text-[14px] font-semibold text-foreground',
          'transition-colors hover:border-[hsl(var(--primary))] hover:text-[hsl(var(--primary))] active:scale-95',
        )}
      >
        <Users className="h-4 w-4" aria-hidden="true" />
        <span>
          {portions} {portions === 1 ? 'Portion' : 'Portionen'}
        </span>
      </button>
    </header>
  )
}
