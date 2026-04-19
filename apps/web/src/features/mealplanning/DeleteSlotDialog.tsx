import { useState } from 'react'
import type { MealPlanSlotDto } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { MealPlanApiError } from './mealPlanApi'
import { useDeleteSlot } from './useMealPlan'

/**
 * Confirmation modal for deleting a meal-plan slot (P3-3).
 *
 * The copy is blunt on purpose — the user already had to open the
 * slot's `…` menu + click "Löschen" to get here, so the "Abbrechen"
 * path is the escape hatch, not the default. The destructive button
 * variant matches our existing pattern in `ConfirmDeleteRecipeDialog`
 * so the visual language stays consistent.
 */
export function DeleteSlotDialog({
  groupId,
  weekStart,
  planId,
  slot,
  childCount = 0,
  onClose,
}: {
  groupId: string
  weekStart: string
  planId: string
  slot: MealPlanSlotDto
  /**
   * Number of slots that reference this slot via `parentSlotId` — i.e.
   * direct leftover children. When > 0 we surface an extra German
   * warning so the user understands the backend behaviour: the kids
   * don't cascade-delete, they just have their parent link nulled (see
   * plan section P3-1).
   */
  childCount?: number
  onClose: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const del = useDeleteSlot(groupId, weekStart, planId)

  async function handleConfirm() {
    setError(null)
    try {
      await del.mutateAsync({ slotId: slot.id })
      onClose()
    } catch (err) {
      if (err instanceof MealPlanApiError) {
        setError(err.message || 'Slot konnte nicht gelöscht werden.')
      } else {
        setError('Slot konnte nicht gelöscht werden.')
      }
    }
  }

  return (
    <div
      role="dialog"
      aria-labelledby="delete-slot-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="delete-slot-dialog-title"
          className="mb-1 font-serif text-xl font-semibold"
        >
          Gericht wirklich löschen?
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Diese Aktion kann nicht rückgängig gemacht werden. Untergeordnete
          Meal-Prep-Slots bleiben erhalten und werden freigestellt.
        </p>

        {childCount > 0 && (
          <p
            role="alert"
            data-testid="delete-slot-parent-warning"
            className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200"
          >
            Dieser Slot ist Meal-Prep-Parent für {childCount}{' '}
            {childCount === 1 ? 'weiteren Slot' : 'weitere Slots'}. Die
            Kinder-Slots werden danach freie Slots (nicht automatisch
            gelöscht).
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
          >
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleConfirm}
            disabled={del.isPending}
          >
            {del.isPending ? 'Löscht …' : 'Löschen'}
          </Button>
        </div>
      </div>
    </div>
  )
}
