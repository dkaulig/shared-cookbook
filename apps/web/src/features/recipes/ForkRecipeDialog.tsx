import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { ApiError } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useMyGroups } from '@/features/groups/useMyGroups'
import { useForkRecipe } from './hooks'

/**
 * Dialog for forking a recipe into another of the user's groups
 * (PRD §4.7). The source group is filtered out because same-group
 * duplication is a rarely-wanted degenerate case — power users can still
 * hit the endpoint directly via curl if they truly need it. After a
 * successful fork the user is navigated to the new recipe's detail page.
 */
export function ForkRecipeDialog({
  recipeId,
  sourceGroupId,
  onClose,
}: {
  recipeId: string
  sourceGroupId: string
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const groups = useMyGroups()
  const [selected, setSelected] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const fork = useForkRecipe(recipeId)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!selected) return

    try {
      const created = await fork.mutateAsync({ targetGroupId: selected })
      onClose()
      navigate(`/groups/${created.groupId}/recipes/${created.id}`)
    } catch (err) {
      const apiErr = err as ApiError
      setError(
        apiErr.message ||
          t('recipes.forkDialog.errorFailed', {
            defaultValue: 'Kopieren fehlgeschlagen.',
          }),
      )
    }
  }

  const options = (groups.data ?? []).filter((g) => g.id !== sourceGroupId)

  return (
    <div
      role="dialog"
      aria-labelledby="fork-recipe-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="fork-recipe-dialog-title" className="mb-4 text-xl font-semibold text-stone-900">
          {t('recipes.forkDialog.title', {
            defaultValue: 'In andere Gruppe kopieren',
          })}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="fork-target-group">
              {t('recipes.forkDialog.targetLabel', {
                defaultValue: 'Zielgruppe',
              })}
            </Label>
            <select
              id="fork-target-group"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="" disabled>
                {t('recipes.forkDialog.selectPlaceholder', {
                  defaultValue: 'Gruppe wählen …',
                })}
              </option>
              {options.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>

          {options.length === 0 && !groups.isLoading && (
            <p className="text-sm text-stone-500">
              {t('recipes.forkDialog.noOtherGroups', {
                defaultValue: 'Du bist in keiner anderen Gruppe Mitglied.',
              })}
            </p>
          )}

          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel', { defaultValue: 'Abbrechen' })}
            </Button>
            <Button type="submit" disabled={!selected || fork.isPending}>
              {t('recipes.forkDialog.submitCta', { defaultValue: 'Kopieren' })}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
