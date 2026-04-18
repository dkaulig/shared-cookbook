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
 * DS6 sticky action bar for the recipe form. Mirrors `.actionbar` in
 * `docs/mockups/warme-kueche-recipe-form.html`:
 *
 *   - Ghost "Abbrechen" on the left — navigates back via `onCancel`.
 *   - Primary "Rezept speichern" / "Änderungen speichern" on the right
 *     with a checkmark icon. Disabled + "Speichere …" while the
 *     mutation is in flight.
 *
 * Positioning math copies DS5's `<RecipeActionBar />`:
 *   - Fixed, inset-x-0, bottom offset clears the BottomNav (72 px
 *     mobile) or just the iOS home indicator on desktop.
 *   - Max-width 3xl + centered so the bar aligns with the form card
 *     stack on tablets/desktops.
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
    <div
      className={cn(
        'pointer-events-none fixed inset-x-0 z-[8] flex justify-center px-3',
        'bottom-[calc(env(safe-area-inset-bottom,0px)+72px)] md:bottom-[env(safe-area-inset-bottom,0px)]',
        className,
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
          onClick={onCancel}
          className={cn(
            'flex-1 inline-flex items-center justify-center gap-2 rounded-[12px] border border-[hsl(var(--input))] bg-card px-4 py-[13px] text-[15px] font-semibold text-foreground',
            'transition-colors hover:border-[hsl(var(--primary))] hover:text-[hsl(var(--primary))] active:scale-[0.99]',
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
            'inline-flex items-center justify-center gap-2 rounded-[12px] border border-[hsl(var(--primary))] bg-[hsl(var(--primary))] px-4 py-[13px] text-[15px] font-semibold text-[hsl(var(--primary-foreground))]',
            'shadow-[0_4px_12px_-4px_rgba(180,83,9,0.45)] transition-colors hover:bg-[hsl(var(--primary-hover,var(--primary)))] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60',
            'flex-[1.3]',
          )}
        >
          <Check className="h-[18px] w-[18px]" strokeWidth={2.4} aria-hidden="true" />
          {pending ? pendingLabel : primaryLabel}
        </button>
      </div>
    </div>
  )
}
