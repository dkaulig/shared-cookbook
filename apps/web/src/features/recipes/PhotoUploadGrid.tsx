import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { UploadCloud, X } from 'lucide-react'
import type { ApiError } from '@familien-kochbuch/shared'
import { cn } from '@/lib/utils'
import { recipePhotoGradient } from './recipePhotoGradient'
import { useRemoveRecipePhoto, useUploadRecipePhoto } from './hooks'

/**
 * UX1-PU extends the grid with a `mode` discriminated-union prop so the
 * same visual shell serves both the edit-mode (live upload) and the
 * create-mode (staged-in-memory files) flows:
 *
 *   - mode='live'   → takes `recipeId` + `photos: string[]`; fires real
 *                     upload / remove mutations against the backend.
 *   - mode='staged' → takes `files: File[]` + `onFilesChange(files)`;
 *                     previews via URL.createObjectURL and revokes on
 *                     remove/unmount. No network calls.
 *
 * Backward-compatible: omitting `mode` defaults to 'live' so the
 * pre-UX1-PU call-site (`<PhotoUploadGrid recipeId={id} photos={xs} />`)
 * keeps working unchanged.
 */

export type PhotoUploadGridProps =
  | LiveProps
  | StagedProps

/**
 * BUG-024 — a photo that's already persisted in SeaweedFS via the
 * staged-upload endpoint but not yet bound to the (yet-unsaved)
 * recipe. Rendered ahead of the staged `File[]` slots so the
 * photo-import review form can show the actual thumbnails the user
 * uploaded in the previous step instead of only a count-badge.
 */
export interface PreAttachedPhoto {
  readonly stagedPhotoId: string
  /** Signed SeaweedFS proxy URL; rendered as `<img src>`. */
  readonly url: string
  /** BUG-018 video thumbnail marker → shows a "Thumbnail" badge. */
  readonly isThumbnail?: boolean
}

interface LiveProps {
  mode?: 'live'
  /** Id of the recipe the photos belong to — drives the upload / remove mutations. */
  recipeId: string
  /** Current signed URLs; we show the first three, one per slot. */
  photos: string[]
  className?: string
}

interface StagedProps {
  mode: 'staged'
  /** Currently staged File objects (parent-controlled). */
  files: File[]
  /** Fired with the next files array when the user adds / removes one. */
  onFilesChange: (files: File[]) => void
  /**
   * BUG-024 — already-server-side-staged photos (either user uploads
   * from `ImportPhotosPage` or the BUG-018 video thumbnail). Rendered
   * as thumbnails BEFORE the file-upload slots so the reviewer sees
   * what will be attached on save. Omitted / empty → grid behaves
   * exactly as before.
   */
  preAttached?: readonly PreAttachedPhoto[]
  /**
   * Invoked when the user taps the × on a pre-attached tile. The
   * parent is responsible for the actual delete (backend + memo
   * update) — this component stays presentational.
   */
  onRemovePreAttached?: (stagedPhotoId: string) => void
  className?: string
}

const MAX_PHOTOS = 3
const LIMIT_ERROR = `Maximal ${MAX_PHOTOS} Fotos pro Rezept — entferne zuerst ein vorhandenes Bild.`
const UNSUPPORTED_TYPE_ERROR = 'Nur JPG, PNG oder WebP unterstützt.'
const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'] as const

function isStaged(props: PhotoUploadGridProps): props is StagedProps {
  return props.mode === 'staged'
}

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
 *   - Live mode: delegates the request to `useUploadRecipePhoto` /
 *     `useRemoveRecipePhoto`, so the page's TanStack cache invalidation
 *     is handled by the hook.
 *   - Staged mode: mutates the parent's `files` array via
 *     `onFilesChange`; previews via `URL.createObjectURL` with revoke on
 *     remove + unmount so blob refs don't leak.
 *
 * While a live request is in flight, the slot shows a "Lade …"
 * placeholder over the gradient so the user gets feedback. Errors
 * persist in `role="alert"` until the next action.
 */
export function PhotoUploadGrid(props: PhotoUploadGridProps) {
  if (isStaged(props)) {
    return <StagedGrid {...props} />
  }
  return <LiveGrid {...props} />
}

function LiveGrid({ recipeId, photos, className }: LiveProps) {
  const upload = useUploadRecipePhoto(recipeId)
  const remove = useRemoveRecipePhoto(recipeId)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

  const atLimit = photos.length >= MAX_PHOTOS

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

  async function handleRemove(url: string) {
    setError(null)
    try {
      await remove.mutateAsync(url)
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message ?? 'Entfernen fehlgeschlagen.')
    }
  }

  return (
    <GridShell
      className={className}
      dragActive={dragActive}
      onDragActiveChange={setDragActive}
      acceptFiles={acceptFiles}
      atLimit={atLimit}
      isPending={upload.isPending}
      inputDisabled={atLimit || upload.isPending}
      fileInputRef={fileInputRef}
      error={error}
      slots={buildSlotsFromUrls(photos)}
      onRemoveFilled={handleRemove}
      filledPending={remove.isPending}
    />
  )
}

function StagedGrid({
  files,
  onFilesChange,
  preAttached,
  onRemovePreAttached,
  className,
}: StagedProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const preAttachedList = preAttached ?? []

  // One blob URL per staged File, kept in state so it survives renders.
  // The array always lines up 1:1 with `files`. We reconcile with the
  // incoming `files` prop during render (React's set-state-during-render
  // pattern) rather than in an effect — lets us avoid the
  // "setState-in-effect" lint rule and keeps the URL lifecycle tied
  // directly to when the file list changes. On unmount we revoke
  // whatever's left.
  const [previews, setPreviews] = useState<Array<{ file: File; url: string }>>(
    () => files.map((f) => ({ file: f, url: URL.createObjectURL(f) })),
  )
  const [prevFiles, setPrevFiles] = useState(files)
  if (files !== prevFiles) {
    setPrevFiles(files)
    const prevByFile = new Map(previews.map((p) => [p.file, p.url]))
    const next = files.map((f) => {
      const existing = prevByFile.get(f)
      if (existing) {
        prevByFile.delete(f)
        return { file: f, url: existing }
      }
      return { file: f, url: URL.createObjectURL(f) }
    })
    // Anything left in `prevByFile` was removed from the list.
    for (const stale of prevByFile.values()) {
      URL.revokeObjectURL(stale)
    }
    setPreviews(next)
  }

  useEffect(() => {
    // Revoke every remaining URL on unmount.
    return () => {
      for (const { url } of previews) {
        URL.revokeObjectURL(url)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount cleanup only
  }, [])

  // BUG-024 — the 3-photo cap spans both preAttached (server-side
  // staged) AND the local `File[]`. The "+ add" slot is hidden once
  // the combined count hits the cap.
  const totalCount = preAttachedList.length + files.length
  const atLimit = totalCount >= MAX_PHOTOS

  function acceptFiles(dropped: FileList | File[]) {
    setError(null)
    const list = Array.from(dropped)
    if (list.length === 0) return
    if (atLimit) {
      setError(LIMIT_ERROR)
      return
    }
    const [first, ...rest] = list
    if (!first) return
    if (!(ACCEPT as readonly string[]).includes(first.type)) {
      setError(UNSUPPORTED_TYPE_ERROR)
      return
    }
    if (rest.length > 0) {
      setError('Bitte wähle immer nur ein Bild — mehrere Dateien sind nicht unterstützt.')
      return
    }
    onFilesChange([...files, first])
  }

  function handleRemove(index: number) {
    setError(null)
    // Revoke eagerly here so the X-click assertion can observe the revoke
    // synchronously with the state update. The reconcile-effect would
    // otherwise only revoke after React commits, one tick too late.
    const target = files[index]
    const cached = previews.find((p) => p.file === target)
    if (cached) {
      URL.revokeObjectURL(cached.url)
    }
    const next = files.filter((_, i) => i !== index)
    onFilesChange(next)
  }

  // BUG-024 — preAttached tiles render first, each as its own Slot
  // variant. They have their own remove button (different handler +
  // badge), so we don't funnel them through `buildSlotsFromUrls`
  // which is blind to the distinction.
  const slots: Slot[] = [
    ...preAttachedList.map(
      (p, i): Slot => ({
        kind: 'preAttached',
        stagedPhotoId: p.stagedPhotoId,
        url: p.url,
        isThumbnail: p.isThumbnail === true,
        index: i,
      }),
    ),
    ...buildSlotsFromUrls(
      previews.map((p) => p.url),
      preAttachedList.length,
      MAX_PHOTOS - preAttachedList.length,
    ),
  ]

  return (
    <GridShell
      className={className}
      dragActive={dragActive}
      onDragActiveChange={setDragActive}
      acceptFiles={acceptFiles}
      atLimit={atLimit}
      isPending={false}
      inputDisabled={atLimit}
      fileInputRef={fileInputRef}
      error={error}
      slots={slots}
      onRemoveFilled={(_url, displayedIndex) => {
        // `displayedIndex` is the grid-wide 0-based slot index the
        // Slot carried. Staged-mode filled slots live AFTER the
        // preAttached tiles, so subtract that offset to map back to
        // the local File[] position.
        handleRemove(displayedIndex - preAttachedList.length)
      }}
      onRemovePreAttached={
        onRemovePreAttached
          ? (stagedPhotoId: string) => onRemovePreAttached(stagedPhotoId)
          : undefined
      }
      filledPending={false}
    />
  )
}

type Slot =
  | { kind: 'filled'; url: string; index: number }
  | { kind: 'empty'; index: number }
  | {
      kind: 'preAttached'
      stagedPhotoId: string
      url: string
      isThumbnail: boolean
      index: number
    }

/**
 * `startIndex` lets callers shift the displayed 1-based slot index
 * (e.g. preAttached tiles come first and consume 0..N, so File[]
 * slots need to start at N+1). `capacity` caps the total number of
 * filled+empty slots produced — caller usually passes
 * `MAX_PHOTOS - preAttachedList.length`.
 */
function buildSlotsFromUrls(
  urls: string[],
  startIndex = 0,
  capacity = MAX_PHOTOS,
): Slot[] {
  const filledCount = Math.min(urls.length, capacity)
  const emptySlots = Math.max(0, capacity - filledCount)
  return [
    ...urls.slice(0, filledCount).map((url, i) => ({
      kind: 'filled' as const,
      url,
      index: startIndex + i,
    })),
    ...Array.from({ length: emptySlots }, (_, i) => ({
      kind: 'empty' as const,
      index: startIndex + filledCount + i,
    })),
  ]
}

interface GridShellProps {
  className?: string
  dragActive: boolean
  onDragActiveChange: (active: boolean) => void
  acceptFiles: (files: FileList | File[]) => void | Promise<void>
  atLimit: boolean
  /** True when a live upload is in flight — hides the drop-zone click-handler text. */
  isPending: boolean
  inputDisabled: boolean
  fileInputRef: React.RefObject<HTMLInputElement | null>
  error: string | null
  slots: Slot[]
  onRemoveFilled: (url: string, index: number) => void
  /**
   * BUG-024 — invoked when the user taps × on a pre-attached tile.
   * Omitted (undefined) hides the remove button on those tiles
   * (useful for a read-only preview mode if we ever want one).
   */
  onRemovePreAttached?: (stagedPhotoId: string) => void
  filledPending: boolean
}

function GridShell({
  className,
  dragActive,
  onDragActiveChange,
  acceptFiles,
  isPending,
  inputDisabled,
  fileInputRef,
  error,
  slots,
  onRemoveFilled,
  onRemovePreAttached,
  filledPending,
}: GridShellProps) {
  function handleInputChange(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (files && files.length > 0) {
      void acceptFiles(files)
    }
    // Reset so the same file can be re-selected after a remove.
    e.target.value = ''
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    onDragActiveChange(true)
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    onDragActiveChange(false)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    onDragActiveChange(false)
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
                onRemove={() => onRemoveFilled(slot.url, slot.index)}
                pending={filledPending}
              />
            )
          }
          if (slot.kind === 'preAttached') {
            return (
              <PreAttachedSlot
                key={`pre-${slot.stagedPhotoId}`}
                stagedPhotoId={slot.stagedPhotoId}
                url={slot.url}
                isThumbnail={slot.isThumbnail}
                index={slot.index + 1}
                onRemove={
                  onRemovePreAttached
                    ? () => onRemovePreAttached(slot.stagedPhotoId)
                    : undefined
                }
              />
            )
          }
          return (
            <DropSlot
              key={`empty-${slot.index}`}
              onClick={() => fileInputRef.current?.click()}
              pending={isPending}
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
        disabled={inputDisabled}
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

/**
 * BUG-024 — a server-side staged-photo tile shown in create-mode
 * during the photo-import review. Identical visuals to the live
 * FilledSlot with two tweaks:
 *   - top-left pill labelling the provenance ("Import" or
 *     "Thumbnail" depending on `isThumbnail`),
 *   - X button stays hidden when no `onRemove` is provided
 *     (caller opted out of the per-tile delete flow).
 */
interface PreAttachedSlotProps {
  stagedPhotoId: string
  url: string
  isThumbnail: boolean
  index: number
  onRemove?: () => void
}

function PreAttachedSlot({
  stagedPhotoId,
  url,
  isThumbnail,
  index,
  onRemove,
}: PreAttachedSlotProps) {
  const badgeLabel = isThumbnail ? 'Thumbnail' : 'Import'
  return (
    <div
      data-testid={`preattached-slot-${stagedPhotoId}`}
      className="relative aspect-square overflow-hidden rounded-[12px] bg-[hsl(var(--muted))]"
      style={{ backgroundImage: recipePhotoGradient(url) }}
    >
      <img
        src={url}
        alt="Rezept-Foto"
        className="h-full w-full object-cover"
        loading="lazy"
      />
      {/* Top-left provenance pill — mirrors the site's
          tag/pill styling (small, muted, pill-shaped). */}
      <span
        data-testid={
          isThumbnail ? 'preattached-thumbnail-badge' : 'preattached-import-badge'
        }
        className="absolute left-1.5 top-1.5 rounded-full bg-[rgba(28,25,23,0.75)] px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.04em] text-white backdrop-blur-sm"
      >
        {badgeLabel}
      </span>
      {onRemove && (
        <button
          type="button"
          aria-label="Importiertes Foto entfernen"
          onClick={onRemove}
          className={cn(
            'absolute right-1.5 top-1.5 grid h-[26px] w-[26px] place-items-center rounded-full',
            'bg-[rgba(28,25,23,0.7)] text-white backdrop-blur-sm transition-colors hover:bg-[hsl(var(--destructive))]',
            'disabled:cursor-not-allowed disabled:opacity-60',
          )}
        >
          <X className="h-[14px] w-[14px]" aria-hidden="true" />
        </button>
      )}
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
