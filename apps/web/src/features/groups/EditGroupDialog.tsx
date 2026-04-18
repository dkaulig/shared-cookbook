import { useState } from 'react'
import type { FormEvent } from 'react'
import type { ApiError } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUpdateGroup } from './hooks'

/**
 * Admin-only dialog for editing a group's metadata (name, description,
 * default_servings, cover image URL).
 */
export function EditGroupDialog({
  groupId,
  initialName,
  initialDescription,
  initialDefaultServings,
  initialCoverImageUrl,
  onClose,
}: {
  groupId: string
  initialName: string
  initialDescription: string
  initialDefaultServings: number
  initialCoverImageUrl: string
  onClose: () => void
}) {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [defaultServings, setDefaultServings] = useState(String(initialDefaultServings))
  const [coverImageUrl, setCoverImageUrl] = useState(initialCoverImageUrl)
  const [error, setError] = useState<string | null>(null)
  const update = useUpdateGroup(groupId)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    const parsedServings = Number.parseFloat(defaultServings)
    if (Number.isNaN(parsedServings) || parsedServings <= 0) {
      setError('Standard-Portionen muss eine positive Zahl sein.')
      return
    }
    if (parsedServings > 20) {
      setError('Standard-Portionen darf höchstens 20 sein.')
      return
    }

    try {
      await update.mutateAsync({
        name: name.trim(),
        description: description.trim() === '' ? undefined : description.trim(),
        defaultServings: parsedServings,
        coverImageUrl: coverImageUrl.trim() === '' ? undefined : coverImageUrl.trim(),
      })
      onClose()
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message || 'Speichern fehlgeschlagen.')
    }
  }

  return (
    <div
      role="dialog"
      aria-labelledby="edit-group-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="edit-group-dialog-title" className="mb-4 text-xl font-semibold text-stone-900">
          Gruppe bearbeiten
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="edit-group-name">Name</Label>
            <Input
              id="edit-group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-group-description">Beschreibung</Label>
            <Input
              id="edit-group-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-group-default-servings">Standard-Portionen</Label>
            <Input
              id="edit-group-default-servings"
              type="number"
              min="0.5"
              max="20"
              step="0.5"
              value={defaultServings}
              onChange={(e) => setDefaultServings(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-group-cover">Cover-Bild URL</Label>
            <Input
              id="edit-group-cover"
              type="url"
              value={coverImageUrl}
              onChange={(e) => setCoverImageUrl(e.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={update.isPending}>
              Speichern
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
