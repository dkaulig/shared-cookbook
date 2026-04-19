import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ApiError, GroupSummary } from '@familien-kochbuch/shared'
import {
  ArrowDown,
  ArrowUp,
  Camera,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useMyGroups } from '@/features/groups/useMyGroups'
import { GroupPickerDialog } from '@/features/groups/GroupPickerDialog'
import { CreateGroupDialog } from '@/features/groups/CreateGroupDialog'
import { useEnqueuePhotoImport } from './hooks'
import { uploadStagedPhoto } from './stagedPhotoApi'
import { rememberImportGroup } from './importGroupMemo'

/**
 * P2-8 — `/rezepte/import/photos` entry form.
 *
 * Mirrors `ImportUrlPage`'s group-picker + enqueue → progress-page
 * handshake but with a photo-upload grid instead of a URL field:
 *
 *   1. User picks 1..10 photos from disk or the mobile camera
 *      (`capture="environment"` on the hidden input).
 *   2. Photos are staged purely in memory as `File` objects — thumbnails
 *      via `URL.createObjectURL` with revoke-on-remove/unmount so blobs
 *      don't leak.
 *   3. Reorder via ↑/↓ buttons per slot (no drag-drop: drag reorder is
 *      fiddly on touch screens and the plan explicitly says buttons-only).
 *   4. On submit:
 *      a. For each staged File (in order): `await uploadStagedPhoto(file)`
 *         — sequential, NOT Promise.all, to avoid hammering the SeaweedFS
 *         filer on spotty mobile connections.
 *      b. POST the collected signed URL array to
 *         `/api/recipes/import/photos` → receive `{ importId }`.
 *      c. Stash the groupId so the progress page + RecipeFormPage know
 *         where to land.
 *      d. Navigate to `/rezepte/import/{importId}` (shared progress page).
 *
 * Group picker branches the same way the URL import does: 0 groups →
 * CreateGroupDialog; 1 group → skip the picker; >1 groups →
 * GroupPickerDialog.
 *
 * HEIC rejection is client-side AND server-side: the hidden `<input>`'s
 * `accept` limits the picker to image/jpeg + image/png + image/webp
 * (browsers that honour the attribute won't even offer HEIC), and our
 * in-memory validation surfaces a German error if the user dragged one
 * in via drag-and-drop.
 */

// Max photos per import — matches the .NET MaxPhotosPerImport and the
// Python pipeline's cap.
const MAX_PHOTOS = 10
const MAX_BYTES = 5 * 1024 * 1024
const ACCEPT: readonly string[] = ['image/jpeg', 'image/png', 'image/webp']

export function ImportPhotosPage() {
  const navigate = useNavigate()
  const groups = useMyGroups()
  const enqueue = useEnqueuePhotoImport()

  const [files, setFiles] = useState<File[]>([])
  const [uploadPhase, setUploadPhase] = useState<
    'idle' | 'uploading' | 'enqueueing'
  >('idle')
  const [uploadedCount, setUploadedCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Preview blob URL per File, created on add and revoked on remove +
  // unmount. We keep the list parallel to `files` so indexing stays
  // trivial in the grid. Reconcile during render (same pattern as
  // PhotoUploadGrid's StagedGrid) so the URLs line up 1:1 without
  // waiting for an effect.
  const [previews, setPreviews] = useState<
    Array<{ file: File; url: string }>
  >(() => files.map((f) => ({ file: f, url: URL.createObjectURL(f) })))
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
    // Anything left in `prevByFile` was removed.
    for (const stale of prevByFile.values()) {
      URL.revokeObjectURL(stale)
    }
    setPreviews(next)
  }

  useEffect(() => {
    return () => {
      for (const { url } of previews) {
        URL.revokeObjectURL(url)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount cleanup only
  }, [])

  function acceptIncoming(dropped: FileList | File[]) {
    setError(null)
    const list = Array.from(dropped)
    if (list.length === 0) return

    // Validate each file before committing — a single bad type in a
    // bulk drop fails the whole batch so the user knows what to fix.
    for (const f of list) {
      if (!ACCEPT.includes(f.type)) {
        setError(
          'Nur JPG, PNG oder WebP werden unterstützt. Bitte HEIC vor dem Import als JPG/PNG speichern.',
        )
        return
      }
      if (f.size > MAX_BYTES) {
        setError(`"${f.name}" ist größer als 5 MB.`)
        return
      }
    }
    if (files.length + list.length > MAX_PHOTOS) {
      setError(`Maximal ${MAX_PHOTOS} Fotos pro Import.`)
      return
    }
    setFiles([...files, ...list])
  }

  function handleInputChange(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files
    if (picked && picked.length > 0) acceptIncoming(picked)
    // Reset so the same file can be picked again after a remove.
    e.target.value = ''
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
    const dropped = e.dataTransfer.files
    if (dropped && dropped.length > 0) acceptIncoming(dropped)
  }

  function handleRemove(index: number) {
    setError(null)
    // Revoke eagerly so assertions observe the revoke synchronously.
    const target = files[index]
    const cached = previews.find((p) => p.file === target)
    if (cached) URL.revokeObjectURL(cached.url)
    setFiles(files.filter((_, i) => i !== index))
  }

  function handleMove(index: number, direction: -1 | 1) {
    setError(null)
    const target = index + direction
    if (target < 0 || target >= files.length) return
    const next = [...files]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved!)
    setFiles(next)
  }

  async function startImportWithGroup(groupId: string) {
    setError(null)
    setUploadPhase('uploading')
    setUploadedCount(0)
    const signedUrls: string[] = []
    try {
      // Sequential upload — see module docstring for rationale.
      for (const file of files) {
        const { signedUrl } = await uploadStagedPhoto(file)
        signedUrls.push(signedUrl)
        setUploadedCount(signedUrls.length)
      }
    } catch (err) {
      setUploadPhase('idle')
      const apiErr = err as ApiError
      setError(apiErr.message || 'Foto-Upload fehlgeschlagen.')
      return
    }

    setUploadPhase('enqueueing')
    try {
      const { importId } = await enqueue.mutateAsync({
        photoUrls: signedUrls,
        groupId,
      })
      // Same sessionStorage sidecar the URL-import uses so the progress
      // page can route to the right group on reload.
      rememberImportGroup(importId, groupId)
      navigate(`/rezepte/import/${importId}`, { state: { groupId } })
    } catch (err) {
      setUploadPhase('idle')
      const apiErr = err as ApiError
      setError(apiErr.message || 'Der Import konnte nicht gestartet werden.')
    }
  }

  async function handleSubmit(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault()
    if (files.length === 0) {
      setError('Bitte füge mindestens ein Foto hinzu.')
      return
    }
    const list = groups.data ?? []
    if (list.length === 0) {
      setCreateGroupOpen(true)
      return
    }
    if (list.length === 1) {
      await startImportWithGroup(list[0]!.id)
      return
    }
    setPickerOpen(true)
  }

  function handleGroupPick(group: GroupSummary) {
    setPickerOpen(false)
    void startImportWithGroup(group.id)
  }

  const submitPending = uploadPhase !== 'idle' || enqueue.isPending
  const atLimit = files.length >= MAX_PHOTOS

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8 md:px-8 md:py-12">
      <div className="mb-6 flex items-center gap-2 text-[13px] font-medium uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
        <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        KI-Import
      </div>
      <h1 className="font-serif text-[clamp(28px,6vw,36px)] font-semibold leading-[1.1] tracking-[-0.015em]">
        Rezept aus Foto importieren
      </h1>
      <p className="mt-2 font-serif-body text-[15px] italic leading-[1.5] text-[hsl(var(--muted-foreground))]">
        Fotografiere eine Rezeptkarte oder lade bis zu 10 Bilder hoch — wir
        erkennen Zutaten und Schritte und du kannst sie vor dem Speichern
        prüfen.
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-8 rounded-[18px] border border-border bg-card p-6 shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
        noValidate
      >
        <label className="flex items-center gap-1.5 text-[13px] font-semibold tracking-[0.01em] text-foreground">
          <Camera className="h-3.5 w-3.5" aria-hidden="true" />
          Fotos ({files.length} / {MAX_PHOTOS})
        </label>

        {/* Photo grid. Each slot is a thumbnail + reorder/remove chrome;
            the last item is an "add" drop-zone until the limit is hit. */}
        <div
          data-testid="photos-grid"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            'mt-3 grid grid-cols-3 gap-2.5 transition-colors sm:grid-cols-4',
            dragActive && 'rounded-[12px] ring-2 ring-primary',
          )}
        >
          {previews.map(({ url }, index) => (
            <FilledSlot
              key={url}
              url={url}
              index={index}
              total={files.length}
              onRemove={() => handleRemove(index)}
              onMoveUp={() => handleMove(index, -1)}
              onMoveDown={() => handleMove(index, 1)}
              disabled={submitPending}
            />
          ))}

          {!atLimit && (
            <AddSlot
              onClick={() => fileInputRef.current?.click()}
              disabled={submitPending}
            />
          )}
        </div>

        <input
          ref={fileInputRef}
          data-testid="photos-file-input"
          type="file"
          accept={ACCEPT.join(',')}
          capture="environment"
          multiple
          className="hidden"
          onChange={handleInputChange}
          disabled={submitPending || atLimit}
        />

        <p className="mt-3 text-[12.5px] text-[hsl(var(--muted-foreground))]">
          Unterstützt: JPG, PNG, WebP bis 5 MB. HEIC (iPhone-Standard) bitte
          vorher als JPG exportieren.
        </p>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
          >
            {error}
          </p>
        )}

        {uploadPhase === 'uploading' && (
          <p
            role="status"
            data-testid="upload-progress"
            className="mt-4 text-[13px] font-medium text-[hsl(var(--muted-foreground))]"
          >
            Fotos werden hochgeladen … ({uploadedCount} / {files.length})
          </p>
        )}

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate(-1)}
            disabled={submitPending}
          >
            Abbrechen
          </Button>
          <Button
            type="submit"
            disabled={submitPending || files.length === 0}
          >
            {uploadPhase === 'uploading'
              ? 'Lädt hoch …'
              : uploadPhase === 'enqueueing' || enqueue.isPending
                ? 'Starte …'
                : 'Rezepte extrahieren'}
          </Button>
        </div>
      </form>

      {pickerOpen && groups.data && groups.data.length > 1 && (
        <GroupPickerDialog
          groups={groups.data}
          onPick={handleGroupPick}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {createGroupOpen && (
        <CreateGroupDialog onClose={() => setCreateGroupOpen(false)} />
      )}
    </main>
  )
}

interface FilledSlotProps {
  url: string
  index: number
  total: number
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  disabled: boolean
}

function FilledSlot({
  url,
  index,
  total,
  onRemove,
  onMoveUp,
  onMoveDown,
  disabled,
}: FilledSlotProps) {
  const isFirst = index === 0
  const isLast = index === total - 1
  return (
    <div className="relative aspect-square overflow-hidden rounded-[12px] bg-[hsl(var(--muted))]">
      <img
        src={url}
        alt={`Foto ${index + 1}`}
        className="h-full w-full object-cover"
        loading="lazy"
      />
      {/* Top-right: remove. */}
      <button
        type="button"
        aria-label={`Foto ${index + 1} entfernen`}
        onClick={onRemove}
        disabled={disabled}
        className={cn(
          'absolute right-1.5 top-1.5 grid h-[26px] w-[26px] place-items-center rounded-full',
          'bg-[rgba(28,25,23,0.7)] text-white backdrop-blur-sm transition-colors hover:bg-[hsl(var(--destructive))]',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        <X className="h-[14px] w-[14px]" aria-hidden="true" />
      </button>
      {/* Bottom-left: slot index badge. */}
      <span
        aria-hidden="true"
        className="absolute bottom-1.5 left-1.5 grid h-[22px] w-[22px] place-items-center rounded-full bg-[rgba(28,25,23,0.7)] text-[11px] font-semibold text-white"
      >
        {index + 1}
      </span>
      {/* Bottom-right: reorder buttons. Hidden when only one photo — the
          arrows would no-op anyway and the visual noise isn't worth it. */}
      {total > 1 && (
        <div className="absolute bottom-1.5 right-1.5 flex gap-1">
          <button
            type="button"
            aria-label={`Foto ${index + 1} nach oben verschieben`}
            onClick={onMoveUp}
            disabled={disabled || isFirst}
            className={cn(
              'grid h-[26px] w-[26px] place-items-center rounded-full',
              'bg-[rgba(28,25,23,0.7)] text-white backdrop-blur-sm transition-colors hover:bg-primary',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <ArrowUp className="h-[14px] w-[14px]" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Foto ${index + 1} nach unten verschieben`}
            onClick={onMoveDown}
            disabled={disabled || isLast}
            className={cn(
              'grid h-[26px] w-[26px] place-items-center rounded-full',
              'bg-[rgba(28,25,23,0.7)] text-white backdrop-blur-sm transition-colors hover:bg-primary',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <ArrowDown className="h-[14px] w-[14px]" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}

function AddSlot({
  onClick,
  disabled,
}: {
  onClick: () => void
  disabled: boolean
}) {
  return (
    <button
      type="button"
      aria-label="Foto hinzufügen"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex aspect-square flex-col items-center justify-center gap-1 rounded-[12px]',
        'border-2 border-dashed border-[hsl(var(--input))] bg-background text-[11px] text-[hsl(var(--muted-foreground))]',
        'transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary',
        'disabled:cursor-not-allowed disabled:opacity-60',
      )}
    >
      <UploadCloud className="h-[22px] w-[22px]" aria-hidden="true" />
      <span className="text-center leading-tight">
        Tippen zum Auswählen
        <br />
        oder hierhin ziehen
      </span>
    </button>
  )
}
