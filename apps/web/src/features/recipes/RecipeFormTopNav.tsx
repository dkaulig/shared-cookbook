import { MoreHorizontal, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface RecipeFormTopNavProps {
  /** Drives the title label: "Neues Rezept" vs. "Rezept bearbeiten". */
  mode: 'create' | 'edit'
  /** Invoked when the user taps the X icon on the left (navigates back). */
  onCancel: () => void
  /**
   * Optional draft-state subtitle override. Defaults to the "unsaved
   * changes" tagline because DS6 ships without autosave; a future slice
   * can swap in "Entwurf gespeichert vor Xs" once the debounce lands.
   */
  subtitle?: string
  /** Parent-driven className (form page controls stacking vs. BottomNav). */
  className?: string
}

/**
 * DS6 form-specific sticky top bar that replaces the shared TopNav on
 * `/groups/:id/recipes/new` and `/groups/:id/recipes/:id/edit`. Mirrors
 * `.topnav` in `docs/mockups/warme-kueche-recipe-form.html`:
 *
 *   - Left: X icon button (Abbrechen) — fires `onCancel`, so the parent
 *     page can route back or hand control to the router.
 *   - Middle: serif title ("Neues Rezept" / "Rezept bearbeiten") with an
 *     11 px subtitle line underneath ("Ungespeicherte Änderungen" by
 *     default).
 *   - Right: more-menu ellipsis button — a no-op placeholder for DS6
 *     (DS7 will wire it to a share / discard-draft menu).
 *
 * The AppLayout suppresses the shared TopNav for these routes so the
 * page only has one top strip.
 */
export function RecipeFormTopNav({
  mode,
  onCancel,
  subtitle,
  className,
}: RecipeFormTopNavProps) {
  const { t } = useTranslation()
  const resolvedSubtitle =
    subtitle ??
    t('recipes.form.topNav.subtitleUnsaved', {
      defaultValue: 'Ungespeicherte Änderungen',
    })
  const title =
    mode === 'create'
      ? t('recipes.form.topNav.createTitle', { defaultValue: 'Neues Rezept' })
      : t('recipes.form.topNav.editTitle', { defaultValue: 'Rezept bearbeiten' })

  return (
    <header
      role="banner"
      className={cn(
        'sticky top-0 z-20 flex items-center gap-2.5 border-b border-border/60 px-4',
        'bg-[hsl(var(--background)/0.92)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background)/0.85)]',
        className,
      )}
      style={{
        paddingTop: 'calc(10px + env(safe-area-inset-top, 0px))',
        paddingBottom: '10px',
      }}
    >
      <button
        type="button"
        aria-label={t('common.cancel', { defaultValue: 'Abbrechen' })}
        onClick={onCancel}
        className={cn(
          'grid h-10 w-10 flex-shrink-0 place-items-center rounded-[10px] text-[hsl(var(--muted-foreground))]',
          'transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground',
        )}
      >
        <X className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>

      <div className="flex min-w-0 flex-1 flex-col leading-[1.1]">
        <div className="font-serif text-[18px] font-semibold tracking-[-0.005em] text-foreground">
          {title}
        </div>
        <div className="text-[11px] text-[hsl(var(--muted-foreground))]">
          {resolvedSubtitle}
        </div>
      </div>

      <button
        type="button"
        aria-label={t('common.more', { defaultValue: 'Mehr' })}
        className={cn(
          'grid h-10 w-10 flex-shrink-0 place-items-center rounded-[10px] text-[hsl(var(--muted-foreground))]',
          'transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground',
        )}
      >
        <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>
    </header>
  )
}
