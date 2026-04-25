import { useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TagCategory } from '@shared-cookbook/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { classifyMutationError } from '@/features/_shared/errorSurface'
import { useCreateGroupTag } from './hooks'

const CATEGORY_DEFAULTS: Record<TagCategory, string> = {
  Custom: 'Eigene',
  Mahlzeit: 'Mahlzeit',
  Saison: 'Saison',
  Typ: 'Typ',
  Aufwand: 'Aufwand',
  Diaet: 'Diät',
  Kueche: 'Küche',
  // GR1 — lets groups author their own Komponente-style sub-recipe
  // tags alongside the seven seeded globals.
  Komponente: 'Komponente',
}
const CATEGORY_VALUES = Object.keys(CATEGORY_DEFAULTS) as TagCategory[]

/**
 * Small modal dialog that creates a new group-scoped tag. Used by
 * <RecipeFilterPanel /> and the <RecipeFormPage /> — after success the
 * tag query cache is invalidated (see useCreateGroupTag), so the new
 * chip shows up immediately in both pickers.
 */
export function CreateTagDialog({
  groupId,
  onClose,
}: {
  groupId: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [category, setCategory] = useState<TagCategory>('Custom')
  const [error, setError] = useState<string | null>(null)
  const mutation = useCreateGroupTag(groupId)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (name.trim().length === 0) {
      setError(
        t('tagManagement.createDialog.nameRequired', {
          defaultValue: 'Name ist erforderlich.',
        }),
      )
      return
    }
    try {
      await mutation.mutateAsync({ name: name.trim(), category })
      onClose()
    } catch (err) {
      // REL-3f — localise via errors.json + drop 5xx leaks.
      setError(classifyMutationError(err).message)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-tag-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 id="create-tag-title" className="mb-4 text-lg font-semibold text-stone-900">
          {t('tagManagement.createDialog.title', { defaultValue: 'Eigenen Tag erstellen' })}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="tag-name">
              {t('tagManagement.createDialog.nameLabel', { defaultValue: 'Name' })}
            </Label>
            <Input
              id="tag-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tag-category">
              {t('tagManagement.createDialog.categoryLabel', { defaultValue: 'Kategorie' })}
            </Label>
            <select
              id="tag-category"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              value={category}
              onChange={(e) => setCategory(e.target.value as TagCategory)}
            >
              {CATEGORY_VALUES.map((value) => (
                <option key={value} value={value}>
                  {t(`tagManagement.createDialog.categoryLabels.${value}`, {
                    defaultValue: CATEGORY_DEFAULTS[value],
                  })}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('tagManagement.createDialog.cancelCta', { defaultValue: 'Abbrechen' })}
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending
                ? t('tagManagement.createDialog.savingCta', { defaultValue: 'Erstelle…' })
                : t('tagManagement.createDialog.submitCta', { defaultValue: 'Tag anlegen' })}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
