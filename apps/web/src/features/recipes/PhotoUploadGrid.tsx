import { useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { UploadCloud, X } from 'lucide-react'
import type { ApiError } from '@familien-kochbuch/shared'
import { cn } from '@/lib/utils'
import { recipePhotoGradient } from './recipePhotoGradient'
import { useRemoveRecipePhoto, useUploadRecipePhoto } from './hooks'

export interface PhotoUploadGridProps {
  /** Id of the recipe the photos belong to — drives the upload / remove mutations. */
  recipeId: string
  /** Current signed URLs; we show the first three, one per slot. */
  photos: string[]
  className?: string
}

const MAX_PHOTOS = 3
const LIMIT_ERROR = `Maximal ${MAX_PHOTOS} Fotos pro Rezept — entferne zuerst ein vorhandenes Bild.`
const UNSUPPORTED_TYPE_ERROR = 'Nur JPG, PNG oder WebP unterstützt.'
const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'] as const

/**
 * DS6 three-slot photo upload grid. Mirrors `.photos` + `.photo-slot` in
 * `docs/mockups/warme-kueche-recipe-form.html`:
 *
 *   - Filled slot: `<img>` cover + dark X-remove in the top-right
 *     + a 22 px circular slot index in the bottom-left (1..3).
 *   - Empty slot: dashed drop-zone with an UploadCloud glyph and
 *     "Tippen zum Auswählen / oder hierhin ziehen" two-line copy. Tapping
 *     opens the hidden file input; dragging a file onto it triggers the
 *     same upload path.
 *
 * Behaviour:
 *   - Enforces a 3-photo cap. Dropping a 4th file surfaces a German
 *     `role="alert"` message instead of silently ignoring.
 *   - Rejects files whose MIME type isn't JPG/PNG/WebP — same error
 *     channel.
 *   - Delegates the actual request to `useUploadRecipePhoto` /
 *     `useRemoveRecipePhoto`, so the page's TanStack cache invalidation
 *     (and photos-array refresh) is handled by the hook.
 *
 * While a request is in flight, the slot shows a "Lade …" placeholder
 * over the gradient so the user gets feedback. Errors persist in
 * `role="alert"` until the next action.
 */
export function PhotoUploadGrid({ recipeId, photos, className }: PhotoUploadGridProps) {
  const upload = useUploadRecipePhoto(recipeId)
  const remove = useRemoveRecipePhoto(recipeId)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

  const atLimit = photos.length >= MAX_PHOTOS
  const emptySlots = Math.max(0, MAX_PHOTOS - photos.length)
  // Always render exactly 3 slots — filled first, drop-zones after.
  const slots: Array<{ kind: 'filled'; url: string; index: number } | { kind: 'empty'; index: number }> = [
    ...photos.slice(0, MAX_PHOTOS).map((url, i) => ({ kind: 'filled' as const, url, index: i })),
    ...Array.from({ length: emptySlots }, (_, i) => ({ kind: 'empty' as const, index: photos.length + i })),
  ]

  async function acceptFiles(files: FileList | File[]) {
    setError(null)
    const list = Array.from(files)
    if (list.length === 0) return
    if (atLimit) {
      setError(LIMIT_ERROR)
      return
    }
    const [first, ...rest] = list
    // Guard the multi-file case explicitly — we accept one per upload
    // since the /photos endpoint is single-file. Extra files get a
    // friendly message instead of an opaque 400.
    if (!first) return
    if (!(ACCEPT as readonly string[]).includes(first.type)) {
      setError(UNSUPPORTED_TYPE_ERROR)
      return
    }
    if (rest.length > 0) {
      setError('Bitte wähle immer nur ein Bild — mehrere Dateien sind nicht unterstützt.')
      return
    }
    try {
      await upload.mutateAsync(first)
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message ?? 'Upload fehlgeschlagen.')
    }
  }

  function handleInputChange(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (files && files.length > 0) {
      void acceptFiles(files)
    }
    // Reset so the same file can be re-selected after a remove.
    e.target.value = ''
  }

  async function handleRemove(url: string) {
    setError(null)
    try {
      await remove.mutateAsync(url)
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message ?? 'Entfernen fehlgeschlagen.')
    }
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragActive(true)
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragActive(false)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragActive(false)
    const files = e.dataTransfer.files
    void acceptFiles(files)
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div
        data-testid="photo-upload-grid"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'grid grid-cols-3 gap-2.5 transition-colors',
          dragActive && 'ring-2 ring-primary rounded-[12px]',
        )}
      >
        {slots.map((slot) => {
          if (slot.kind === 'filled') {
            return (
              <FilledSlot
                key={`filled-${slot.index}`}
                url={slot.url}
                index={slot.index + 1}
                onRemove={() => handleRemove(slot.url)}
                pending={remove.isPending}
              />
            )
          }
          return (
            <DropSlot
              key={`empty-${slot.index}`}
              onClick={() => fileInputRef.current?.click()}
              pending={upload.isPending}
            />
          )
        })}
      </div>

      <input
        ref={fileInputRef}
        data-testid="photo-upload-input"
        type="file"
        accept={ACCEPT.join(',')}
        className="hidden"
        onChange={handleInputChange}
        disabled={atLimit || upload.isPending}
      />

      {error && (
        <p
          role="alert"
          className="rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
        >
          {error}
        </p>
      )}
    </div>
  )
}

interface FilledSlotProps {
  url: string
  index: number
  onRemove: () => void
  pending: boolean
}

function FilledSlot({ url, index, onRemove, pending }: FilledSlotProps) {
  return (
    <div
      className="relative aspect-square overflow-hidden rounded-[12px] bg-[hsl(var(--muted))]"
      style={{ backgroundImage: recipePhotoGradient(url) }}
    >
      <img
        src={url}
        alt="Rezept-Foto"
        className="h-full w-full object-cover"
        loading="lazy"
      />
      <button
        type="button"
        aria-label="Foto entfernen"
        onClick={onRemove}
        disabled={pending}
        className={cn(
          'absolute right-1.5 top-1.5 grid h-[26px] w-[26px] place-items-center rounded-full',
          'bg-[rgba(28,25,23,0.7)] text-white backdrop-blur-sm transition-colors hover:bg-[hsl(var(--destructive))]',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        <X className="h-[14px] w-[14px]" aria-hidden="true" />
      </button>
      <span
        aria-hidden="true"
        className="absolute bottom-1.5 left-1.5 grid h-[22px] w-[22px] place-items-center rounded-full bg-[rgba(28,25,23,0.7)] text-[11px] font-semibold text-white"
      >
        {index}
      </span>
    </div>
  )
}

interface DropSlotProps {
  onClick: () => void
  pending: boolean
}

function DropSlot({ onClick, pending }: DropSlotProps) {
  return (
    <button
      type="button"
      aria-label="Foto hochladen"
      onClick={onClick}
      disabled={pending}
      className={cn(
        'flex aspect-square flex-col items-center justify-center gap-1 rounded-[12px]',
        'border-2 border-dashed border-[hsl(var(--input))] bg-background text-[11px] text-[hsl(var(--muted-foreground))]',
        'transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary',
        'disabled:cursor-not-allowed disabled:opacity-60',
      )}
    >
      <UploadCloud className="h-[22px] w-[22px]" aria-hidden="true" />
      <span className="text-center leading-tight">
        {pending ? 'Lade …' : (
          <>
            Tippen zum Auswählen
            <br />
            oder hierhin ziehen
          </>
        )}
      </span>
    </button>
  )
}
