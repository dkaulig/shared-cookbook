import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import type { IngredientDto } from '@familien-kochbuch/shared'
import type { ScaledIngredient } from '@familien-kochbuch/shared'
import { scaleIngredients } from '@familien-kochbuch/shared'
import { cn } from '@/lib/utils'

export interface IngredientChecklistProps {
  /** Raw ingredients from the recipe detail DTO. */
  ingredients: IngredientDto[]
  /** Recipe's own default-servings count — the "from" side of the scaling ratio. */
  defaultServings: number
  /** Currently selected target servings — the "to" side. */
  servings: number
}

/**
 * DS5 tap-to-check ingredient list. Each row is a button with
 * role="checkbox" so keyboard + screen-reader users get the right
 * semantics. Check state lives in local React state (a Set of ids) —
 * session-only UX convenience, not server-persisted.
 *
 * Visual shell mirrors .ingredients / .ing-row in
 * docs/mockups/warme-kueche-recipe-detail.html.
 *
 * Scaling math is delegated to scaleIngredients() from
 * @familien-kochbuch/shared so the wire-level contract stays with the
 * domain utility.
 */
export function IngredientChecklist({
  ingredients,
  defaultServings,
  servings,
}: IngredientChecklistProps) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set())

  const scaled = useMemo<ScaledIngredient[]>(() => {
    if (servings <= 0 || defaultServings <= 0) return []
    return scaleIngredients(
      ingredients.map((i) => ({
        quantity: i.quantity ?? null,
        unit: i.unit,
        name: i.name,
        scalable: i.scalable,
      })),
      defaultServings,
      servings,
    )
  }, [ingredients, defaultServings, servings])

  function rowKey(ingredient: IngredientDto, index: number): string {
    return ingredient.id ?? `pos-${ingredient.position}-${index}`
  }

  function toggle(key: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
      {ingredients.map((ingredient, index) => {
        const key = rowKey(ingredient, index)
        const display = scaled[index]
        const isChecked = checked.has(key)
        return (
          <IngredientRow
            key={key}
            ingredient={ingredient}
            display={display}
            isChecked={isChecked}
            onToggle={() => toggle(key)}
            isLast={index === ingredients.length - 1}
          />
        )
      })}
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
        'flex w-full items-center gap-3.5 px-4 py-3 text-left transition-colors hover:bg-[hsl(var(--muted))]',
        !isLast && 'border-b border-[hsl(var(--border)/0.55)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid h-[22px] w-[22px] flex-shrink-0 place-items-center rounded-md border-[1.5px] transition-all',
          isChecked
            ? 'border-[hsl(142_71%_29%)] bg-[hsl(142_71%_29%)] text-white'
            : 'border-[hsl(var(--input))] text-transparent',
        )}
      >
        <Check className="h-[14px] w-[14px]" strokeWidth={3} />
      </span>
      <span
        className={cn(
          'min-w-[80px] flex-shrink-0 font-semibold text-foreground',
          '[font-variant-numeric:tabular-nums] text-[15px]',
          isChecked && 'text-[hsl(var(--muted-foreground))]',
        )}
      >
        <AmountText display={display} />
      </span>
      <span
        className={cn(
          'flex-1 text-[15px] leading-snug text-foreground',
          isChecked && 'line-through text-[hsl(var(--muted-foreground))]',
        )}
      >
        {ingredient.name}
        {ingredient.note && (
          <span className="mt-0.5 block text-[12.5px] text-[hsl(var(--muted-foreground))]">
            {ingredient.note}
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * Amount-column renderer. Splits the shared displayQuantity string so
 * German convention words ("nach Geschmack", "eine Prise") and the
 * "Stück" unit label render in italic Libre-Baskerville per mockup,
 * while the numeric part keeps the tabular-nums treatment.
 */
function AmountText({ display }: { display: ScaledIngredient | undefined }) {
  if (!display) return null

  const text = display.displayQuantity

  if (text === 'nach Geschmack' || text === 'eine Prise') {
    return (
      <em className="font-serif-body font-normal italic text-[13px] text-[hsl(var(--muted-foreground))]">
        {text}
      </em>
    )
  }

  // Stück / Stk / Stueck: the unit word is rendered italic; the number
  // keeps its regular, bold, tabular-nums treatment.
  const stueckMatch = /^(~?\d[\d.,]*)\s+(Stück|Stk|Stueck)$/.exec(text)
  if (stueckMatch) {
    const [, numeric, unit] = stueckMatch
    return (
      <>
        {numeric}{' '}
        <em className="font-serif-body font-normal italic text-[13px] text-[hsl(var(--muted-foreground))]">
          {unit}
        </em>
      </>
    )
  }

  return <>{text}</>
}
