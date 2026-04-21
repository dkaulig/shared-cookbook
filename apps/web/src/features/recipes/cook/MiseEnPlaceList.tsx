import { useMemo } from 'react'
import { Check } from 'lucide-react'
import type { IngredientDto, ScaledIngredient } from '@familien-kochbuch/shared'
import { scaleIngredients } from '@familien-kochbuch/shared'
import { cn } from '@/lib/utils'

export interface MiseEnPlaceListProps {
  /** Raw ingredients from the recipe detail DTO. */
  ingredients: IngredientDto[]
  /** Recipe's own default-servings count — "from" side of the scaling ratio. */
  defaultServings: number
  /** Session portions chosen in the picker — "to" side of the scaling ratio. */
  sessionServings: number
  /** Checked-state — owned by the parent so it survives re-opening the portions picker. */
  checked: Set<string>
  /** Parent-owned toggle — receives the row key. */
  onToggle: (key: string) => void
}

/**
 * COOK-0 Mise-en-Place checklist (Step 0).
 *
 * Bigger-than-IngredientChecklist version of the same tap-to-check
 * grid: ~72 px row, 52 px checkbox, 20-22 px body copy. Same scaling
 * math via the shared `scaleIngredients` helper so rounding and unit
 * formatting match the detail page exactly.
 *
 * Checked-state lives on the parent (`CookModePage`) so it persists
 * across step-navigation and even across a re-open of the portions
 * picker. Scaled quantities re-render automatically when the session
 * portions change — the check state is keyed on a stable row key that
 * doesn't depend on the scaled value.
 */
export function MiseEnPlaceList({
  ingredients,
  defaultServings,
  sessionServings,
  checked,
  onToggle,
}: MiseEnPlaceListProps) {
  const scaled = useMemo<ScaledIngredient[]>(() => {
    if (sessionServings <= 0 || defaultServings <= 0) return []
    return scaleIngredients(
      ingredients.map((i) => ({
        quantity: i.quantity ?? null,
        unit: i.unit,
        name: i.name,
        scalable: i.scalable,
      })),
      defaultServings,
      sessionServings,
    )
  }, [ingredients, defaultServings, sessionServings])

  function rowKey(ingredient: IngredientDto, index: number): string {
    return ingredient.id ?? `pos-${ingredient.position}-${index}`
  }

  return (
    <div
      data-testid="cook-mise-en-place"
      className="mx-auto w-full max-w-2xl px-6 pb-6 md:px-12"
    >
      <h2 className="mb-2 font-serif text-[30px] font-semibold tracking-[-0.01em] text-foreground md:text-[36px]">
        Mise en Place
      </h2>
      <p className="mb-6 text-[16px] leading-relaxed text-[hsl(var(--muted-foreground))] md:text-[18px]">
        Bereite diese Zutaten vor. Tippe zum Abhaken, wenn alles bereit
        ist.
      </p>

      <ul className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
        {ingredients.map((ingredient, index) => {
          const key = rowKey(ingredient, index)
          const display = scaled[index]
          const isChecked = checked.has(key)
          return (
            <li key={key}>
              <IngredientRow
                ingredient={ingredient}
                display={display}
                isChecked={isChecked}
                onToggle={() => onToggle(key)}
                isLast={index === ingredients.length - 1}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function IngredientRow({
  ingredient,
  display,
  isChecked,
  onToggle,
  isLast,
}: {
  ingredient: IngredientDto
  display: ScaledIngredient | undefined
  isChecked: boolean
  onToggle: () => void
  isLast: boolean
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={isChecked}
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-4 px-5 py-5 text-left transition-colors hover:bg-[hsl(var(--muted))]',
        // min-h so a 44×44 tap target is guaranteed even if the row
        // content would otherwise be shorter; reserved space prevents
        // the line-through variant from causing a layout shift.
        'min-h-[72px]',
        !isLast && 'border-b border-[hsl(var(--border)/0.55)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid h-[32px] w-[32px] flex-shrink-0 place-items-center rounded-md border-2 transition-all',
          isChecked
            ? 'border-[hsl(142_71%_29%)] bg-[hsl(142_71%_29%)] text-white'
            : 'border-[hsl(var(--input))] text-transparent',
        )}
      >
        <Check className="h-5 w-5" strokeWidth={3} />
      </span>
      <span
        className={cn(
          'min-w-[100px] flex-shrink-0 font-semibold text-foreground',
          '[font-variant-numeric:tabular-nums] text-[19px]',
          isChecked && 'text-[hsl(var(--muted-foreground))]',
        )}
      >
        {display?.displayQuantity ?? ''}
      </span>
      <span
        className={cn(
          'flex-1 text-[19px] leading-snug text-foreground',
          isChecked && 'line-through text-[hsl(var(--muted-foreground))]',
        )}
      >
        {ingredient.name}
        {ingredient.note && (
          <span className="mt-0.5 block text-[14px] text-[hsl(var(--muted-foreground))]">
            {ingredient.note}
          </span>
        )}
      </span>
    </button>
  )
}
