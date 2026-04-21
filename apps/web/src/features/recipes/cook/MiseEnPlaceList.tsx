import { useEffect, useMemo, useRef, useState } from 'react'
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
  /**
   * COOK-2 — when set, the matching ingredient row is scrolled into
   * view + briefly ring-highlighted (1.5 s). The parent clears the
   * state after the flash; this component keeps the ring local for the
   * duration so jitter from upstream re-renders doesn't cut the flash.
   */
  highlightedIngredientId?: string | null
}

/**
 * COOK-0 + COOK-2 Mise-en-Place checklist (Step 0).
 *
 * Bigger-than-IngredientChecklist version of the same tap-to-check
 * grid: ~72 px row, 52 px checkbox, 20-22 px body copy. Same scaling
 * math via the shared `scaleIngredients` helper so rounding and unit
 * formatting match the detail page exactly.
 *
 * COOK-2 adds an optional `highlightedIngredientId` prop. When an
 * ingredient chip in a cook-step is tapped, `CookModePage` navigates
 * back to step 0 and sets this prop — we then scroll the row into
 * view + apply a ring highlight that fades out after 1.5 s.
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
  highlightedIngredientId = null,
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

  // Flash-ring state. The ring is ON whenever the `flashOnFor` id
  // matches the ingredient's id. We derive the initial value from the
  // prop so the ring is visible on the VERY FIRST render after the
  // parent sets `highlightedIngredientId`. The effect below is only
  // responsible for the FADE-OUT (1.5 s later) — it never turns the
  // ring ON from within an effect, which keeps `react-hooks/
  // set-state-in-effect` happy.
  const [flashOffFor, setFlashOffFor] = useState<string | null>(null)
  const rowRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map())

  useEffect(() => {
    if (highlightedIngredientId == null) return
    const target = rowRefs.current.get(highlightedIngredientId)
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    const clearHandle = setTimeout(() => {
      setFlashOffFor(highlightedIngredientId)
    }, 1500)
    return () => clearTimeout(clearHandle)
  }, [highlightedIngredientId])

  // The ring is ON if the prop names a non-null id AND the fade-out
  // timer for THAT SAME id hasn't fired yet.
  const flashId =
    highlightedIngredientId != null && flashOffFor !== highlightedIngredientId
      ? highlightedIngredientId
      : null

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
          const isHighlighted = flashId != null && flashId === ingredient.id
          return (
            <li key={key}>
              <IngredientRow
                ingredient={ingredient}
                display={display}
                isChecked={isChecked}
                isHighlighted={isHighlighted}
                onToggle={() => onToggle(key)}
                isLast={index === ingredients.length - 1}
                registerRef={(el) => {
                  if (ingredient.id) rowRefs.current.set(ingredient.id, el)
                }}
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
  isHighlighted,
  onToggle,
  isLast,
  registerRef,
}: {
  ingredient: IngredientDto
  display: ScaledIngredient | undefined
  isChecked: boolean
  isHighlighted: boolean
  onToggle: () => void
  isLast: boolean
  registerRef: (el: HTMLButtonElement | null) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={isChecked}
      onClick={onToggle}
      ref={registerRef}
      className={cn(
        'flex w-full items-center gap-4 px-5 py-5 text-left transition-[background-color,box-shadow] duration-300 hover:bg-[hsl(var(--muted))]',
        // min-h so a 44×44 tap target is guaranteed even if the row
        // content would otherwise be shorter; reserved space prevents
        // the line-through variant from causing a layout shift.
        'min-h-[72px]',
        !isLast && 'border-b border-[hsl(var(--border)/0.55)]',
        isHighlighted && 'ring-2 ring-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]',
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
