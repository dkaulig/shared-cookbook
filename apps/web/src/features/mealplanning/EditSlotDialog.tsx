import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type {
  MealPlanSlotDto,
  PatchSlotRequest,
} from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useRecipes } from '@/features/recipes/hooks'
import { MealPlanApiError } from './mealPlanApi'
import { buildParentLabel, eligibleParents } from './parentSlotHelpers'
import { usePatchSlot } from './useMealPlan'
import { MEAL_SLOT_LABELS, formatGermanDate } from './weekGrid'

/**
 * Modal for editing an existing meal-plan slot (P3-3).
 *
 * Follows JSON Merge Patch semantics: only fields the user actually
 * changed end up in the PATCH body. Fields left untouched stay
 * `undefined` in state and are stripped by `patchSlot` before the
 * request goes out (see `mealPlanApi.stripUndefined`).
 *
 * Scope (matches the P3-1 `SlotPatchRequest` DTO the backend accepts):
 *   - `recipeId` — swap to another recipe or clear to "free text"
 *   - `label`   — free-form title (max 40 chars, validated server-side)
 *   - `servings`— 1..50 per domain; form caps at 1..20 like AddSlot
 *   - `isCooked`— "Gekocht"-Toggle
 *
 * `date` and `meal` are deliberately read-only in this dialog. The
 * backend PATCH DTO doesn't accept them (only AddSlot does), and the
 * master plan defers cross-cell drag to P3-10. Users can delete +
 * re-add if they need to move a slot to another cell today.
 *
 * `parentSlotId` is editable via the "Ist Rest von …" dropdown
 * introduced in P3-4 — the option list excludes the slot itself and
 * any of its descendants so the user can't create a cycle.
 */
export function EditSlotDialog({
  groupId,
  weekStart,
  planId,
  slot,
  existingSlots,
  onClose,
}: {
  groupId: string
  weekStart: string
  planId: string
  slot: MealPlanSlotDto
  /**
   * All slots currently on the plan — needed by the P3-4 parent-slot
   * dropdown so we can exclude the slot being edited + its descendants
   * from the candidate list. Required so wiring bugs (caller forgot
   * to pipe the plan slots through) surface at compile time rather
   * than silently hiding the dropdown. Pass an explicit `[slot]` for
   * the "no other slots" test-harness case.
   */
  existingSlots: readonly MealPlanSlotDto[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [recipeId, setRecipeId] = useState<string | null>(slot.recipeId)
  const [label, setLabel] = useState<string>(slot.label ?? '')
  const [servings, setServings] = useState<number>(slot.servings)
  const [isCooked, setIsCooked] = useState<boolean>(slot.isCooked)
  const [parentSlotId, setParentSlotId] = useState<string | null>(
    slot.parentSlotId,
  )
  const [error, setError] = useState<string | null>(null)

  // PAGE-1 — stopgap until the Cross-Group-Search slice: pull the full
  // (title-sorted) list in one shot so the picker can filter client-side.
  const search = useRecipes(groupId, { pageSize: 100, sort: 'title_asc' })
  const patch = usePatchSlot(groupId, weekStart, planId)

  // Exclude the slot being edited + its descendants so the picker
  // cannot construct a cycle. Descendant lookup is O(N² worst-case)
  // but N is the slot-count for a single week (≤ 28 cells × a few
  // slots), which is trivial.
  const parentCandidates = useMemo(
    () => eligibleParents(slot.id, existingSlots),
    [slot.id, existingSlots],
  )

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    const trimmedLabel = label.trim()
    const hasRecipe = recipeId !== null
    const hasLabel = trimmedLabel.length > 0
    if (!hasRecipe && !hasLabel) {
      setError('Bitte wähle ein Rezept oder gib einen Titel ein.')
      return
    }
    if (!Number.isFinite(servings) || servings < 1 || servings > 20) {
      setError('Portionen müssen zwischen 1 und 20 liegen.')
      return
    }

    // Build a JSON Merge Patch body containing only the fields that
    // differ from the original slot. `undefined` means "leave alone"
    // (stripped by the API layer); explicit `null` means "clear".
    const body: PatchSlotRequest = {}

    if (recipeId !== slot.recipeId) {
      body.recipeId = recipeId
    }

    // When a recipe is selected, the label slot is conceptually a
    // sidecar note: an empty string clears it. When there's no recipe
    // the label IS the title so we keep the trimmed string. Either
    // way the wire value is "trimmed string or null" — compared
    // against the slot's current label to decide whether to ship it.
    const normalisedLabel: string | null =
      hasRecipe && trimmedLabel.length === 0 ? null : trimmedLabel || null
    if (normalisedLabel !== (slot.label ?? null)) {
      body.label = normalisedLabel
    }

    if (servings !== slot.servings) {
      body.servings = servings
    }

    if (isCooked !== slot.isCooked) {
      body.isCooked = isCooked
    }

    // Only ship parentSlotId when it actually changed — JSON Merge
    // Patch semantics: `undefined` = leave alone, `null` = clear.
    if (parentSlotId !== slot.parentSlotId) {
      body.parentSlotId = parentSlotId
    }

    if (Object.keys(body).length === 0) {
      // Nothing changed — just close without firing a request.
      onClose()
      return
    }

    try {
      await patch.mutateAsync({ slotId: slot.id, patch: body })
      onClose()
    } catch (err) {
      if (err instanceof MealPlanApiError) {
        setError(err.message || 'Slot konnte nicht gespeichert werden.')
      } else {
        setError('Slot konnte nicht gespeichert werden.')
      }
    }
  }

  // Client-side filter on the typed query — cheap at pageSize=100.
  const recipes = useMemo(() => {
    const all = search.data?.items ?? []
    const q = query.trim().toLowerCase()
    if (q.length === 0) return all.slice(0, 8)
    return all
      .filter((r) => r.title.toLowerCase().includes(q))
      .slice(0, 8)
  }, [search.data?.items, query])

  return (
    <div
      role="dialog"
      aria-labelledby="edit-slot-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="edit-slot-dialog-title"
          className="mb-1 font-serif text-xl font-semibold"
        >
          Gericht bearbeiten
        </h2>
        <p className="text-sm text-muted-foreground">
          {formatGermanDate(slot.date)} · {MEAL_SLOT_LABELS[slot.meal]}
        </p>
        <p className="mb-4 text-xs text-muted-foreground">
          Zum Verschieben: Slot löschen und neu anlegen.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="edit-slot-search">Rezept suchen</Label>
            <Input
              id="edit-slot-search"
              type="search"
              placeholder="Titel eingeben …"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                // Clear the pinned selection whenever the query changes
                // so the user doesn't accidentally save a stale pick.
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
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>Rezept verknüpft.</span>
                <button
                  type="button"
                  onClick={() => {
                    setRecipeId(null)
                    setQuery('')
                  }}
                  className="text-xs text-[hsl(var(--destructive))] underline-offset-2 hover:underline"
                >
                  Rezept entfernen
                </button>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-slot-label">
              {recipeId ? 'Notiz (optional)' : 'Freier Titel'}
            </Label>
            <Input
              id="edit-slot-label"
              type="text"
              placeholder={recipeId ? 'z.B. doppelte Portion' : 'z.B. Reste, Restaurant'}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={40}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-slot-servings">Portionen</Label>
            <Input
              id="edit-slot-servings"
              type="number"
              min={1}
              max={20}
              value={servings}
              onChange={(e) => setServings(Number(e.target.value))}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="edit-slot-cooked"
              type="checkbox"
              checked={isCooked}
              onChange={(e) => setIsCooked(e.target.checked)}
              className="h-4 w-4 rounded border-input text-primary focus:ring-2 focus:ring-ring/40"
            />
            <Label htmlFor="edit-slot-cooked" className="!m-0 cursor-pointer">
              Gekocht
            </Label>
          </div>

          {parentCandidates.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="edit-slot-parent">Ist Rest von</Label>
              <Select
                id="edit-slot-parent"
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
            <Button type="submit" disabled={patch.isPending}>
              {patch.isPending ? 'Speichert …' : 'Speichern'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
