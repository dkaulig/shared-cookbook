import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FormActionBarProps {
  mode: 'create' | 'edit'
  /** True while create/update mutation is in flight. Disables the primary. */
  pending: boolean
  /**
   * UX1-PU — when true, the primary button keeps its disabled/busy shell
   * but swaps the label to "Fotos hochladen …". The recipe itself is
   * already saved at this point; we're just drip-uploading the staged
   * files before we navigate.
   */
  uploadingPhotos?: boolean
  onCancel: () => void
  onSubmit: () => void
  className?: string
}

/**
 * DS6 contextual action bar for the recipe form. Mirrors `.actionbar`
 * in `docs/mockups/warme-kueche-recipe-form.html`:
 *
 *   - Ghost "Abbrechen" on the left — navigates back via `onCancel`.
 *   - Primary "Rezept speichern" / "Änderungen speichern" on the right
 *     with a checkmark icon. Disabled + "Speichere …" while the
 *     mutation is in flight.
 *
 * BUG-036 — the bar used to hand-position itself with a `fixed bottom-
 * [calc(…)]` wrapper that stacked above BottomNav. It now renders as
 * a plain 2-button row and is pushed into the unified Bottom-Zone slot
 * by `RecipeFormPage` via `useBottomZoneSlot(…)`. The positioning +
 * backdrop-blur now live on the single shared BottomNav container.
 */
export function FormActionBar({
  mode,
  pending,
  uploadingPhotos = false,
  onCancel,
  onSubmit,
  className,
}: FormActionBarProps) {
  const primaryLabel = mode === 'create' ? 'Rezept speichern' : 'Änderungen speichern'
  const pendingLabel = uploadingPhotos ? 'Fotos hochladen …' : 'Speichere …'

  return (
    <>
      <button
        type="button"
        onClick={onCancel}
        className={cn(
          'flex-1 inline-flex items-center justify-center gap-2 rounded-[12px] border border-[hsl(var(--input))] bg-card px-4 py-[11px] text-[15px] font-semibold text-foreground',
          'transition-colors hover:border-[hsl(var(--primary))] hover:text-[hsl(var(--primary))] active:scale-[0.99]',
          className,
        )}
      >
        Abbrechen
      </button>
      <button
        type="button"
        onClick={onSubmit}
        disabled={pending}
        aria-label={pending ? pendingLabel : primaryLabel}
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-[12px] border border-[hsl(var(--primary))] bg-[hsl(var(--primary))] px-4 py-[11px] text-[15px] font-semibold text-[hsl(var(--primary-foreground))]',
          'shadow-[0_4px_12px_-4px_rgba(180,83,9,0.45)] transition-colors hover:bg-[hsl(var(--primary-hover,var(--primary)))] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60',
          'flex-[1.3]',
        )}
      >
        <Check className="h-[18px] w-[18px]" strokeWidth={2.4} aria-hidden="true" />
        {pending ? pendingLabel : primaryLabel}
      </button>
    </>
  )
}
