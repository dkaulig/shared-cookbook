import { Minus, Plus, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { MAX_SERVINGS, MIN_SERVINGS, clampPortions } from './portions'

export interface PortionStepperCardProps {
  /** Current servings (integer, 1..99). Controlled by the parent. */
  servings: number
  /**
   * Fired when the user taps +, –, or the group-default shortcut. The
   * component clamps the candidate value into 1..99 before calling.
   */
  onServingsChange: (next: number) => void
  /**
   * Owning group's default servings. Drives the shortcut button below the
   * stepper. May be fractional (group settings allow 0.5 increments for
   * very small households); we round on emit since the stepper state is
   * integer-only.
   */
  groupDefaultServings: number
  /** Human-readable group name for the shortcut button copy. */
  groupName: string
  /** Extra classes on the outer card (parent-driven spacing). */
  className?: string
}

/**
 * DS5 portion stepper card — the visual shell around the recipe detail
 * page's servings control. Pill-shaped −/value/+ cluster plus a dashed
 * ghost button "Für {Gruppe} umrechnen (N Portionen)" underneath.
 *
 * This component is intentionally presentational: no scaling math, no
 * local `useState`. The parent holds the servings count so the
 * `IngredientChecklist` sibling (which also reads servings) stays in
 * sync without a shared-store indirection.
 *
 * Behaviour mirrors `.portion-stepper` / `.portion-shortcut` in
 * `docs/mockups/warme-kueche-recipe-detail.html`.
 */
export function PortionStepperCard({
  servings,
  onServingsChange,
  groupDefaultServings,
  groupName,
  className,
}: PortionStepperCardProps) {
  const { t } = useTranslation()
  const atMin = servings <= MIN_SERVINGS
  const atMax = servings >= MAX_SERVINGS

  function emit(next: number) {
    onServingsChange(clampPortions(next))
  }

  return (
    <div
      className={cn(
        'rounded-[18px] border border-border bg-card px-5 py-[18px] shadow-[0_1px_2px_rgba(28,25,23,0.04)]',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-semibold uppercase tracking-[0.02em] text-[hsl(var(--muted-foreground))]">
          {t('recipes.portions.title', { defaultValue: 'Portionen' })}
        </div>
        <div
          className="inline-flex items-stretch overflow-hidden rounded-full border border-[hsl(var(--input))] bg-background"
          role="group"
          aria-label={t('recipes.portions.stepperAria', {
            defaultValue: 'Portionen-Stepper',
          })}
        >
          <button
            type="button"
            aria-label={t('recipes.portions.decrement', {
              defaultValue: 'Portion verringern',
            })}
            onClick={() => emit(servings - 1)}
            disabled={atMin}
            className={cn(
              'grid w-10 place-items-center text-[18px] font-semibold text-[hsl(var(--muted-foreground))]',
              'transition-colors hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[hsl(var(--muted-foreground))] active:scale-95',
            )}
          >
            <Minus className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
          <div className="flex min-w-[70px] flex-col items-center justify-center px-2.5 py-1.5 text-[17px] font-bold leading-[1.1] text-foreground">
            {servings}
            <small className="text-[10px] font-medium uppercase tracking-[0.04em] text-[hsl(var(--muted-foreground))]">
              {t('recipes.portions.personsLabel', { defaultValue: 'Personen' })}
            </small>
          </div>
          <button
            type="button"
            aria-label={t('recipes.portions.increment', {
              defaultValue: 'Portion erhöhen',
            })}
            onClick={() => emit(servings + 1)}
            disabled={atMax}
            className={cn(
              'grid w-10 place-items-center text-[18px] font-semibold text-[hsl(var(--muted-foreground))]',
              'transition-colors hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[hsl(var(--muted-foreground))] active:scale-95',
            )}
          >
            <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={() => emit(groupDefaultServings)}
        className={cn(
          'mt-3 inline-flex items-center gap-2 rounded-[10px] border border-dashed border-[hsl(var(--input))] bg-transparent px-3 py-2 text-[13px] font-semibold text-[hsl(var(--primary))]',
          'transition-colors hover:border-[hsl(var(--primary))] hover:bg-[hsl(var(--secondary))]',
        )}
      >
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        {t('recipes.portions.groupDefaultTemplate', {
          name: groupName,
          count: Math.round(groupDefaultServings),
          defaultValue: `Für ${groupName} umrechnen (${Math.round(
            groupDefaultServings,
          )} Portionen)`,
        })}
      </button>
    </div>
  )
}
