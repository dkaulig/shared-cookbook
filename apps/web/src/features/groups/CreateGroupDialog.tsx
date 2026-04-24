import { useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { classifyMutationError } from '@/features/_shared/errorSurface'
import { useCreateGroup } from './hooks'

/**
 * Dialog for creating a new group. German labels throughout. Submission is
 * disabled while the name is blank; server errors surface inline as a
 * screen-reader-announced alert.
 */
export function CreateGroupDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const createGroup = useCreateGroup()

  const canSubmit = name.trim().length > 0 && !createGroup.isPending

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) return

    try {
      await createGroup.mutateAsync({
        name: name.trim(),
        description: description.trim() === '' ? undefined : description.trim(),
      })
      onClose()
    } catch (err) {
      // REL-3f — route through classifyMutationError so backend error-
      // codes surface as the localised `errors.json` copy and 5xx / raw-
      // English Dev-Messages never reach the user.
      setError(classifyMutationError(err).message)
    }
  }

  return (
    <div
      role="dialog"
      aria-labelledby="create-group-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="create-group-dialog-title" className="mb-4 text-xl font-semibold text-stone-900">
          {t('groups.create.title')}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="group-name">{t('groups.create.nameLabel')}</Label>
            <Input
              id="group-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="group-description">
              {t('groups.create.descriptionLabel')}
            </Label>
            <Input
              id="group-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {t('groups.create.submitCta')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
