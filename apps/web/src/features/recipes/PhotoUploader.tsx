import { useState } from 'react'
import type { ChangeEvent } from 'react'
import type { ApiError } from '@familien-kochbuch/shared'
import { useRemoveRecipePhoto, useUploadRecipePhoto } from './hooks'

const MAX_PHOTOS = 3

/**
 * Inline photo manager for a recipe. Shows thumbnails with a remove button
 * and a file input for adding up to three photos. Errors (type, size, over
 * limit) surface inline in German.
 */
export function PhotoUploader({
  recipeId,
  photos,
}: {
  recipeId: string
  photos: string[]
}) {
  const upload = useUploadRecipePhoto(recipeId)
  const remove = useRemoveRecipePhoto(recipeId)
  const [error, setError] = useState<string | null>(null)

  const atLimit = photos.length >= MAX_PHOTOS

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    setError(null)
    const file = e.target.files?.[0]
    if (!file) return
    if (atLimit) {
      setError(`Es sind maximal ${MAX_PHOTOS} Fotos pro Rezept erlaubt.`)
      return
    }
    try {
      await upload.mutateAsync(file)
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message || 'Upload fehlgeschlagen.')
    } finally {
      // Reset the input so the same file can be re-picked later.
      e.target.value = ''
    }
  }

  async function handleRemove(url: string) {
    setError(null)
    try {
      await remove.mutateAsync(url)
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message || 'Entfernen fehlgeschlagen.')
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {photos.map((url) => (
          <figure key={url} className="relative h-24 w-24 overflow-hidden rounded-md ring-1 ring-border">
            <img src={url} alt="Rezept-Foto" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => handleRemove(url)}
              className="absolute right-1 top-1 rounded-full bg-white/90 px-2 text-xs text-stone-700 shadow"
              aria-label="Foto entfernen"
            >
              ✕
            </button>
          </figure>
        ))}
      </div>

      {!atLimit && (
        <label className="flex flex-col gap-2 text-sm text-stone-700">
          <span>Neues Foto hochladen (JPEG, PNG, WebP — max. 5 MB, max. 3 Fotos)</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFile}
            disabled={upload.isPending}
          />
        </label>
      )}

      {upload.isPending && <p className="text-sm text-stone-500">Lade hoch …</p>}

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          {error}
        </p>
      )}
    </div>
  )
}
