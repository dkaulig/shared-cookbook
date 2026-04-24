import { useState } from 'react'
import type { FormEvent } from 'react'
import type { TagCategory } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { classifyMutationError } from '@/features/_shared/errorSurface'
import { useCreateGroupTag } from './hooks'

const CATEGORIES: { value: TagCategory; label: string }[] = [
  { value: 'Custom', label: 'Eigene' },
  { value: 'Mahlzeit', label: 'Mahlzeit' },
  { value: 'Saison', label: 'Saison' },
  { value: 'Typ', label: 'Typ' },
  { value: 'Aufwand', label: 'Aufwand' },
  { value: 'Diaet', label: 'Diät' },
  { value: 'Kueche', label: 'Küche' },
  // GR1 — lets groups author their own Komponente-style sub-recipe
  // tags alongside the seven seeded globals.
  { value: 'Komponente', label: 'Komponente' },
]

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
  const [name, setName] = useState('')
  const [category, setCategory] = useState<TagCategory>('Custom')
  const [error, setError] = useState<string | null>(null)
  const mutation = useCreateGroupTag(groupId)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (name.trim().length === 0) {
      setError('Name ist erforderlich.')
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
          Eigenen Tag erstellen
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="tag-name">Name</Label>
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
            <Label htmlFor="tag-category">Kategorie</Label>
            <select
              id="tag-category"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              value={category}
              onChange={(e) => setCategory(e.target.value as TagCategory)}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
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
              Abbrechen
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Erstelle…' : 'Tag anlegen'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
