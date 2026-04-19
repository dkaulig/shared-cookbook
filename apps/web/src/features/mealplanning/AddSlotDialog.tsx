import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type {
  AddSlotRequest,
  ApiError,
  MealPlanSlotDto,
  MealSlot,
} from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useRecipeSearch } from '@/features/search/hooks'
import { buildParentLabel, eligibleParents } from './parentSlotHelpers'
import { useAddSlot } from './useMealPlan'
import { MEAL_SLOTS, MEAL_SLOT_LABELS, formatGermanDate } from './weekGrid'

/**
 * Modal for adding a new slot to the weekly meal plan.
 *
 * The user either picks an existing recipe from the group-scoped search
 * (reusing `useRecipeSearch` with a debounced query string — same hook
 * the GroupDetailPage uses) or types a free-text label (e.g. "Reste",
 * "Restaurant"). The AddSlot endpoint accepts either — see
 * `AddSlotRequest` in `packages/shared/src/types/mealPlanning.ts` — but
 * the form enforces "at least one" up front so we never submit an empty
 * payload.
 *
 * `sortOrder` is deliberately **not** a form field. The backend auto-
 * computes it (`NextSortOrderAsync` in `MealPlanEndpoints.cs`) which
 * matches the P3-2 spec: users reorder slots in P3-3 via drag-and-drop,
 * not via raw integers in this dialog.
 */
export function AddSlotDialog({
  groupId,
  weekStart,
  planId,
  initialDate,
  initialMeal,
  existingSlots,
  onClose,
}: {
  groupId: string
  weekStart: string
  planId: string
  initialDate: string
  initialMeal: MealSlot
  /**
   * All slots currently on the plan — used to populate the "Ist Rest
   * von …" dropdown so the user can link the new slot to an existing
   * meal-prep parent (P3-4). Defaults to an empty list so earlier call
   * sites that don't have the data handy still compile.
   */
  existingSlots?: readonly MealPlanSlotDto[]
  onClose: () => void
}) {
  const [date, setDate] = useState(initialDate)
  const [meal, setMeal] = useState<MealSlot>(initialMeal)
  const [query, setQuery] = useState('')
  const [recipeId, setRecipeId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [servings, setServings] = useState(2)
  const [parentSlotId, setParentSlotId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const search = useRecipeSearch(groupId, { q: query || undefined, pageSize: 8 })
  const addSlot = useAddSlot(groupId, weekStart, planId)

  // Creating a new slot, so there's no "self" to exclude — pass `null`
  // as the editing-slot-id so every current slot is a valid candidate.
  const parentCandidates = useMemo(
    () => eligibleParents(null, existingSlots ?? []),
    [existingSlots],
  )

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const trimmedLabel = label.trim()
    if (!recipeId && trimmedLabel.length === 0) {
      setError('Bitte wähle ein Rezept oder gib einen Titel ein.')
      return
    }
    if (!Number.isFinite(servings) || servings < 1 || servings > 20) {
      setError('Portionen müssen zwischen 1 und 20 liegen.')
      return
    }
    const body: AddSlotRequest = {
      recipeId: recipeId,
      label: recipeId ? null : trimmedLabel,
      date,
      meal,
      servings,
    }
    if (parentSlotId !== null) {
      // Only ship the parent ref when the user actually picked one; the
      // backend treats an absent key as "no parent" just like an
      // explicit `null`, so we save one wire byte + one DB column write.
      body.parentSlotId = parentSlotId
    }
    try {
      await addSlot.mutateAsync(body)
      onClose()
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message || 'Slot konnte nicht angelegt werden.')
    }
  }

  const recipes = search.data?.items ?? []

  return (
    <div
      role="dialog"
      aria-labelledby="add-slot-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="add-slot-dialog-title"
          className="mb-1 font-serif text-xl font-semibold"
        >
          Gericht hinzufügen
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {formatGermanDate(date)} · {MEAL_SLOT_LABELS[meal]}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="add-slot-date">Datum</Label>
              <Input
                id="add-slot-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-slot-meal">Mahlzeit</Label>
              <Select
                id="add-slot-meal"
                value={meal}
                onChange={(e) => setMeal(e.target.value as MealSlot)}
              >
                {MEAL_SLOTS.map((m) => (
                  <option key={m} value={m}>
                    {MEAL_SLOT_LABELS[m]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-slot-search">Rezept suchen</Label>
            <Input
              id="add-slot-search"
              type="search"
              placeholder="Titel eingeben …"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                // Clear the pinned selection whenever the query changes
                // so the user doesn't accidentally submit a stale pick
                // after typing further refinements.
                if (recipeId) setRecipeId(null)
              }}
            />
            {recipes.length > 0 && (
              <ul
                aria-label="Rezepttreffer"
                className="max-h-40 divide-y divide-border overflow-y-auto rounded-md border border-input bg-background"
              >
                {recipes.map((r) => {
                  const selected = r.id === recipeId
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setRecipeId(r.id)
                          setLabel('')
                          setQuery(r.title)
                        }}
                        aria-pressed={selected}
                        className={
                          'block w-full px-3 py-2 text-left text-sm transition-colors ' +
                          (selected
                            ? 'bg-primary/10 text-foreground'
                            : 'hover:bg-primary/5')
                        }
                      >
                        {r.title}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {recipeId && (
              <p className="text-xs text-muted-foreground">
                Ausgewählt — alternativ Suche leeren und frei eingeben.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-slot-label">
              {recipeId ? 'Notiz (optional)' : 'Freier Titel'}
            </Label>
            <Input
              id="add-slot-label"
              type="text"
              placeholder={recipeId ? 'z.B. doppelte Portion' : 'z.B. Reste, Restaurant'}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={!!recipeId}
              maxLength={40}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-slot-servings">Portionen</Label>
            <Input
              id="add-slot-servings"
              type="number"
              min={1}
              max={20}
              value={servings}
              onChange={(e) => setServings(Number(e.target.value))}
            />
          </div>

          {parentCandidates.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="add-slot-parent">Ist Rest von</Label>
              <Select
                id="add-slot-parent"
                value={parentSlotId ?? ''}
                onChange={(e) =>
                  setParentSlotId(e.target.value === '' ? null : e.target.value)
                }
              >
                <option value="">— kein Parent —</option>
                {parentCandidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {buildParentLabel(p)}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
            >
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={addSlot.isPending}>
              {addSlot.isPending ? 'Speichert …' : 'Hinzufügen'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
