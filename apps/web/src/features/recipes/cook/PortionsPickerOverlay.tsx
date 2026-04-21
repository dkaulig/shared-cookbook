import { Minus, Plus, Users } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface PortionsPickerOverlayProps {
  /** Current session portions — parent-owned state. */
  value: number
  /** Emits the clamped next value. Range 1..99 (kitchen-practical). */
  onChange: (next: number) => void
  /** User confirms the choice — proceed to mise-en-place. */
  onConfirm: () => void
  /** User aborts the cook-mode entry. */
  onCancel: () => void
  /**
   * Recipe's own default servings — shown as a small hint so the user
   * remembers what the recipe is calibrated for. Not a shortcut button,
   * just info. The cook flow defaults `value` to this on first mount.
   */
  recipeDefaultServings: number
}

const MIN_SERVINGS = 1
const MAX_SERVINGS = 99

function clamp(value: number): number {
  if (!Number.isFinite(value)) return MIN_SERVINGS
  if (value < MIN_SERVINGS) return MIN_SERVINGS
  if (value > MAX_SERVINGS) return MAX_SERVINGS
  return Math.round(value)
}

/**
 * COOK-0 Portions-Picker Overlay (Step −1).
 *
 * First screen of the cook flow — asks the user how many portions
 * they're cooking for right now and seeds the session portion count.
 * Deliberately oversized: 44×44 tap targets, big serif heading, sage
 * colour accents. No math happens here — the ingredient scaling fires
 * further downstream on the mise-en-place list.
 *
 * The stepper controls are disabled at the range boundaries (1..99)
 * so keyboard/SR users can't push past practical cooking quantities.
 */
export function PortionsPickerOverlay({
  value,
  onChange,
  onConfirm,
  onCancel,
  recipeDefaultServings,
}: PortionsPickerOverlayProps) {
  const atMin = value <= MIN_SERVINGS
  const atMax = value >= MAX_SERVINGS

  function emit(next: number) {
    onChange(clamp(next))
  }

  return (
    <section
      data-testid="cook-portions-picker"
      aria-labelledby="cook-portions-heading"
      className="mx-auto flex w-full max-w-2xl flex-col items-center px-6 py-10 text-center md:px-12"
    >
      <div
        aria-hidden="true"
        className="mb-6 grid h-[72px] w-[72px] place-items-center rounded-full bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"
      >
        <Users className="h-9 w-9" />
      </div>

      <h1
        id="cook-portions-heading"
        className="mb-3 font-serif text-[30px] font-semibold leading-tight tracking-[-0.01em] text-foreground md:text-[38px]"
      >
        Für wie viele Portionen kochst du?
      </h1>
      <p className="mb-10 max-w-[32ch] text-[17px] leading-relaxed text-[hsl(var(--muted-foreground))] md:text-[19px]">
        Wir skalieren alle Zutaten passend zu deiner Wahl. Du kannst das
        später jederzeit ändern.
      </p>

      <div
        role="group"
        aria-label="Portionen-Stepper"
        className="mb-4 inline-flex items-stretch overflow-hidden rounded-full border-2 border-[hsl(var(--input))] bg-background"
      >
        <button
          type="button"
          aria-label="Portion verringern"
          onClick={() => emit(value - 1)}
          disabled={atMin}
          className={cn(
            'grid h-[72px] w-[72px] place-items-center text-[24px] font-semibold text-[hsl(var(--muted-foreground))]',
            'transition-colors hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-40 active:scale-95',
          )}
        >
          <Minus className="h-7 w-7" aria-hidden="true" />
        </button>
        <div
          aria-live="polite"
          className="flex min-w-[120px] flex-col items-center justify-center px-4 py-2 text-[44px] font-bold leading-none text-foreground [font-variant-numeric:tabular-nums]"
        >
          {value}
          <span className="mt-1 text-[12px] font-medium uppercase tracking-[0.04em] text-[hsl(var(--muted-foreground))]">
            Personen
          </span>
        </div>
        <button
          type="button"
          aria-label="Portion erhöhen"
          onClick={() => emit(value + 1)}
          disabled={atMax}
          className={cn(
            'grid h-[72px] w-[72px] place-items-center text-[24px] font-semibold text-[hsl(var(--muted-foreground))]',
            'transition-colors hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-40 active:scale-95',
          )}
        >
          <Plus className="h-7 w-7" aria-hidden="true" />
        </button>
      </div>
      <p className="mb-10 text-[13px] text-[hsl(var(--muted-foreground))]">
        Das Rezept ist ursprünglich für {recipeDefaultServings}{' '}
        {recipeDefaultServings === 1 ? 'Portion' : 'Portionen'} angelegt.
      </p>

      <div className="flex w-full max-w-md flex-col gap-3">
        <button
          type="button"
          onClick={onConfirm}
          className={cn(
            'inline-flex min-h-[56px] items-center justify-center rounded-[14px] bg-[hsl(var(--primary))] px-6 text-[18px] font-semibold text-[hsl(var(--primary-foreground))]',
            'shadow-[0_4px_12px_-4px_rgba(180,83,9,0.45)] transition-colors hover:bg-[hsl(var(--primary-hover,var(--primary)))] active:scale-[0.99]',
          )}
        >
          Weiter
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            'inline-flex min-h-[48px] items-center justify-center rounded-[14px] bg-transparent px-6 text-[16px] font-semibold text-[hsl(var(--muted-foreground))]',
            'transition-colors hover:text-foreground',
          )}
        >
          Abbrechen
        </button>
      </div>
    </section>
  )
}
