import { useState } from 'react'
import type { FormEvent } from 'react'
import type {
  AddShoppingListItemRequest,
  IngredientCategory,
} from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { ALL_CATEGORIES, CATEGORY_LABELS } from './categoryLabels'
import { useAddShoppingListItem } from './useShoppingList'
import { ShoppingListApiError } from './shoppingListApi'

/**
 * Modal for manually adding a line to the shopping list. Matches the
 * AddSlotDialog visual pattern (fixed overlay + centred card + Escape
 * handled via the browser's native form semantics + outside-click-to-
 * close) so we don't need a dialog primitive.
 *
 * The backend pins `source = Manual` on anything posted through this
 * route, so we don't ship a `source` field — see `ShoppingListEndpoints.
 * AddItemAsync`. `category` defaults to `Sonstiges` server-side when
 * omitted; we still surface the full dropdown so the user can file the
 * item directly into the correct supermarket aisle without waiting for
 * a regenerate.
 */
export function AddItemDialog({
  planId,
  listId,
  onClose,
}: {
  planId: string
  listId: string
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState('')
  const [note, setNote] = useState('')
  const [category, setCategory] = useState<IngredientCategory>('Sonstiges')
  const [error, setError] = useState<string | null>(null)

  const addMutation = useAddShoppingListItem(planId, listId)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const trimmedName = name.trim()
    if (trimmedName.length === 0) {
      setError('Bitte gib einen Namen ein.')
      return
    }
    const body: AddShoppingListItemRequest = {
      name: trimmedName,
      category,
    }
    const trimmedQuantity = quantity.trim()
    const trimmedUnit = unit.trim()
    const trimmedNote = note.trim()
    if (trimmedQuantity.length > 0) body.quantity = trimmedQuantity
    if (trimmedUnit.length > 0) body.unit = trimmedUnit
    if (trimmedNote.length > 0) body.note = trimmedNote

    try {
      await addMutation.mutateAsync(body)
      onClose()
    } catch (err) {
      if (err instanceof ShoppingListApiError) {
        setError(err.message || 'Eintrag konnte nicht angelegt werden.')
      } else {
        setError('Eintrag konnte nicht angelegt werden.')
      }
    }
  }

  return (
    <div
      role="dialog"
      aria-labelledby="add-shopping-item-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="add-shopping-item-dialog-title"
          className="mb-1 font-serif text-xl font-semibold"
        >
          Eintrag hinzufügen
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Manuelle Ergänzung zur Einkaufsliste.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="add-item-name">Name</Label>
            <Input
              id="add-item-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="z.B. Avocado"
              maxLength={200}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="add-item-quantity">Menge (optional)</Label>
              <Input
                id="add-item-quantity"
                type="text"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="z.B. 2"
                maxLength={32}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-item-unit">Einheit (optional)</Label>
              <Input
                id="add-item-unit"
                type="text"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="z.B. Stk"
                maxLength={32}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-item-category">Kategorie</Label>
            <Select
              id="add-item-category"
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as IngredientCategory)
              }
            >
              {ALL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-item-note">Notiz (optional)</Label>
            <Input
              id="add-item-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="z.B. reif, bio"
              maxLength={200}
            />
          </div>

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
            <Button type="submit" disabled={addMutation.isPending}>
              {addMutation.isPending ? 'Speichert …' : 'Hinzufügen'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
