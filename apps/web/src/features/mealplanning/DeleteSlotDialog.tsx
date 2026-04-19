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
  onClose,
}: {
  groupId: string
  weekStart: string
  planId: string
  slot: MealPlanSlotDto
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
