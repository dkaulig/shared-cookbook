import { useMemo, useState } from 'react'
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

interface ScalerState {
  /** The clamped numeric servings count used for scaling math. */
  servings: number
  /**
   * The live text in the input — may transiently differ from `servings`
   * (e.g. empty while the user clears the field before retyping). Always
   * kept in sync whenever `servings` is updated via buttons or the group
   * shortcut.
   */
  draft: string
}

function stateFromServings(servings: number): ScalerState {
  return { servings, draft: String(servings) }
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
 * Implementation note: `servings` and `draft` are stored in a single
 * state object so every update is atomic — updating servings via a
 * button always brings the text field along for the ride without needing
 * a follow-up `useEffect` sync (which violates the set-state-in-effect
 * lint rule).
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
  const [state, setState] = useState<ScalerState>(() => stateFromServings(clamp(defaultServings)))
  const { servings, draft } = state

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
    if (raw === '') {
      // Transient empty state while the user is clearing/retyping — keep
      // servings pinned to the min so any scaling mid-edit uses something
      // valid.
      setState({ servings: MIN_SERVINGS, draft: raw })
      return
    }
    const parsed = Number.parseFloat(raw)
    if (Number.isNaN(parsed)) {
      setState({ servings, draft: raw })
      return
    }
    const clamped = clamp(parsed)
    // If the value overshoots the cap, echo the clamped value back into
    // the textbox so the UI reflects what the scaler is actually using.
    setState({
      servings: clamped,
      draft: clamped !== parsed ? String(clamped) : raw,
    })
  }

  function handleDecrement() {
    setState(stateFromServings(clamp(servings - 1)))
  }

  function handleIncrement() {
    setState(stateFromServings(clamp(servings + 1)))
  }

  function handleUseGroupDefault() {
    setState(stateFromServings(clamp(groupDefaultServings)))
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
