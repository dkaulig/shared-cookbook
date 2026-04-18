import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { IngredientDto } from '@familien-kochbuch/shared'
import { scaleIngredients, type ScalableIngredient } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const MIN_SERVINGS = 1
const MAX_SERVINGS = 99

function clamp(value: number): number {
  if (!Number.isFinite(value)) return MIN_SERVINGS
  if (value < MIN_SERVINGS) return MIN_SERVINGS
  if (value > MAX_SERVINGS) return MAX_SERVINGS
  return value
}

function toScalableIngredient(i: IngredientDto): ScalableIngredient {
  return {
    quantity: i.quantity ?? null,
    unit: i.unit,
    name: i.name,
    scalable: i.scalable,
  }
}

/**
 * Live portion-scaling widget for the recipe detail page (PRD §4.5). The
 * user picks a target servings count via ±1 buttons, direct numeric input,
 * or the "Für {Gruppe} umrechnen" shortcut. The ingredient list below
 * re-renders with scaled quantities computed by `scaleIngredients()` in
 * `@familien-kochbuch/shared`.
 *
 * Input is clamped to the inclusive range [1, 99]. Fractional servings
 * coming in via the group default are passed through to the scaler
 * verbatim but displayed rounded in the button label for readability.
 *
 * Implementation detail: the servings state is the clamped numeric value
 * used for scaling, but we also carry a draft string so typing "2" after
 * clearing the field actually produces "2" on screen rather than getting
 * folded into the previous value. Every draft edit re-parses into
 * `servings` via the same clamp so the integer is always valid.
 */
export function RecipePortionScaler({
  defaultServings,
  groupDefaultServings,
  groupName,
  ingredients,
}: {
  defaultServings: number
  groupDefaultServings: number
  groupName: string
  ingredients: IngredientDto[]
}) {
  const [servings, setServings] = useState<number>(() => clamp(defaultServings))
  // The live text in the input box; may be transiently empty while the user
  // is clearing before retyping. `servings` is always kept in sync with the
  // clamped parse of this string.
  const [draft, setDraft] = useState<string>(() => String(clamp(defaultServings)))

  // Keep draft in sync when servings is changed externally (button click,
  // group-default shortcut).
  useEffect(() => {
    setDraft(String(servings))
  }, [servings])

  const scaled = useMemo(() => {
    if (servings <= 0 || defaultServings <= 0) return []
    return scaleIngredients(
      ingredients.map(toScalableIngredient),
      defaultServings,
      servings,
    )
  }, [ingredients, defaultServings, servings])

  function handleInputChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value
    setDraft(raw)
    if (raw === '') return
    const parsed = Number.parseFloat(raw)
    if (Number.isNaN(parsed)) return
    const clamped = clamp(parsed)
    setServings(clamped)
    // If the raw input would parse to something outside [1, 99], echo the
    // clamped value back into the draft so the textbox reflects what the
    // scaler is actually using.
    if (clamped !== parsed) {
      setDraft(String(clamped))
    }
  }

  function handleDecrement() {
    setServings((s) => clamp(s - 1))
  }

  function handleIncrement() {
    setServings((s) => clamp(s + 1))
  }

  function handleUseGroupDefault() {
    setServings(clamp(groupDefaultServings))
  }

  const groupButtonLabel = `Für ${groupName} umrechnen (${Math.round(groupDefaultServings)} Portionen)`

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Portion verringern"
          onClick={handleDecrement}
          disabled={servings <= MIN_SERVINGS}
        >
          −
        </Button>
        <Label htmlFor="recipe-portion-scaler-input" className="flex items-center gap-2 text-sm text-stone-700">
          Portionen
          <Input
            id="recipe-portion-scaler-input"
            type="number"
            min={MIN_SERVINGS}
            max={MAX_SERVINGS}
            step={1}
            value={draft}
            onChange={handleInputChange}
            className="h-8 w-20 text-center"
          />
        </Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Portion erhöhen"
          onClick={handleIncrement}
          disabled={servings >= MAX_SERVINGS}
        >
          +
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={handleUseGroupDefault}>
          {groupButtonLabel}
        </Button>
      </div>

      <ul className="divide-y">
        {scaled.map((i, idx) => (
          <li
            key={ingredients[idx]?.id ?? `${ingredients[idx]?.position ?? idx}-${i.name}`}
            className="flex gap-3 py-2 text-sm"
          >
            <span className="w-32 shrink-0 text-stone-700">{i.displayQuantity}</span>
            <span className="text-stone-900">
              {i.name}
              {ingredients[idx]?.note && (
                <span className="text-stone-500"> — {ingredients[idx]?.note}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
