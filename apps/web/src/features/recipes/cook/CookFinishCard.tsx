import { useState } from 'react'
import { PartyPopper } from 'lucide-react'
import type { ApiError } from '@shared-cookbook/shared'
import { cn } from '@/lib/utils'

export interface CookFinishCardProps {
  /**
   * Fires the mark-cooked mutation. Returns the Promise so the card can
   * show its own success/failure state and drive the navigation. Parent
   * owns the mutation itself.
   */
  onMarkCooked: () => Promise<unknown>
  /** True while the mutation is in flight — disables the primary button. */
  markCookedPending: boolean
  /** Plain close — navigates back without marking cooked. */
  onClose: () => void
  /**
   * Fires after the mark-cooked mutation resolves successfully. Typical
   * use: navigate back to the recipe detail page so the user lands on a
   * "zuletzt gekocht"-badge update.
   */
  onMarkedCooked: () => void
}

/**
 * COOK-0 Finish Card (Step N+1).
 *
 * "Geschafft!"-celebration screen. Big serif heading, PartyPopper
 * icon, two buttons: primary "Jetzt gekocht" fires the mark-cooked
 * mutation and navigates back; ghost "Schliessen" just exits.
 *
 * The primary button owns its own in-flight + error UX so the
 * `CookModePage` parent stays simple — it just hands us the mutation
 * runner + the pending flag.
 */
export function CookFinishCard({
  onMarkCooked,
  markCookedPending,
  onClose,
  onMarkedCooked,
}: CookFinishCardProps) {
  const [error, setError] = useState<string | null>(null)

  async function handleMarkCookedClick() {
    setError(null)
    try {
      await onMarkCooked()
      onMarkedCooked()
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message ?? 'Speichern fehlgeschlagen.')
    }
  }

  return (
    <section
      data-testid="cook-finish-card"
      aria-labelledby="cook-finish-heading"
      className="mx-auto flex w-full max-w-2xl flex-col items-center px-6 py-12 text-center md:px-12"
    >
      <div
        aria-hidden="true"
        className="mb-6 grid h-[88px] w-[88px] place-items-center rounded-full bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"
      >
        <PartyPopper className="h-11 w-11" strokeWidth={1.8} />
      </div>
      <h1
        id="cook-finish-heading"
        className="mb-3 font-serif text-[34px] font-semibold leading-tight tracking-[-0.01em] text-foreground md:text-[42px]"
      >
        Geschafft!
      </h1>
      <p className="mb-10 max-w-[32ch] text-[19px] leading-relaxed text-[hsl(var(--muted-foreground))] md:text-[20px]">
        Möchtest du das Rezept als gekocht markieren?
      </p>

      {error && (
        <p
          role="alert"
          className="mb-6 max-w-md rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-4 py-2 text-[14px] text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
        >
          {error}
        </p>
      )}

      <div className="flex w-full max-w-md flex-col gap-3">
        <button
          type="button"
          onClick={handleMarkCookedClick}
          disabled={markCookedPending}
          className={cn(
            'inline-flex min-h-[56px] items-center justify-center rounded-[14px] bg-[hsl(var(--primary))] px-6 text-[18px] font-semibold text-[hsl(var(--primary-foreground))]',
            'shadow-[0_4px_12px_-4px_rgba(180,83,9,0.45)] transition-colors hover:bg-[hsl(var(--primary-hover,var(--primary)))] active:scale-[0.99]',
            'disabled:cursor-not-allowed disabled:opacity-60',
          )}
        >
          {markCookedPending ? 'Speichere…' : 'Jetzt gekocht'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className={cn(
            'inline-flex min-h-[48px] items-center justify-center rounded-[14px] bg-transparent px-6 text-[16px] font-semibold text-[hsl(var(--muted-foreground))]',
            'transition-colors hover:text-foreground',
          )}
        >
          Schliessen
        </button>
      </div>
    </section>
  )
}
