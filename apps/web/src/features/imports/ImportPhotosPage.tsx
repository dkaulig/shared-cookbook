import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { GroupSummary } from '@familien-kochbuch/shared'
import i18n from '@/i18n'
import {
  ArrowDown,
  ArrowUp,
  Camera,
  Image as ImageIcon,
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
import {
  rememberImportGroup,
  rememberImportStagedPhotos,
  type ImportStagedPhotoMemo,
} from './importGroupMemo'
import { AiDisabledNotice } from '@/features/_shared/AiDisabledNotice'
import { useFeatures } from '@/features/_shared/useFeatures'
import { classifyMutationError } from '@/features/_shared/errorSurface'

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
  // REL-7 — AI must be on for photo import (vision LLM call). The
  // feature-gate runs BEFORE all the form's hooks so the hooks-order
  // rule stays intact even if features flip between renders
  // (placeholder → fetched-data transition). The gate branches
  // between two disjoint sub-components, each owning its own hook
  // tree — React treats them as separate components and the rule
  // applies per-component, not across the conditional.
  const features = useFeatures()
  const { t } = useTranslation()
  if (!features.ai.features.photoImport) {
    return (
      <AiDisabledNotice
        title={t('imports.photoPage.aiOff.title', {
          defaultValue: 'Foto-Import benötigt KI',
        })}
        description={t('imports.photoPage.aiOff.description', {
          defaultValue:
            'Diese Instanz läuft ohne KI-Anbieter. Foto-Importe brauchen die Vision-KI, um Zutaten und Schritte aus Seitenfotos zu lesen.',
        })}
      />
    )
  }
  return <ImportPhotosPageForm />
}

function ImportPhotosPageForm() {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const groups = useMyGroups()
  const enqueue = useEnqueuePhotoImport()

  // SHARE-1 — blobs arriving from the Web Share Target flow. Router
  // state is read ONCE (on mount), filtered to the same MIME allowlist
  // the gallery/camera inputs use, and then the state is cleared via
  // `history.replaceState` so a remount (focus regain, hot reload)
  // doesn't re-stage the same blobs a second time.
  const [initialFiles, initialToast] = useInitialSharedFiles(location)
  const [files, setFiles] = useState<File[]>(initialFiles)
  const [uploadPhase, setUploadPhase] = useState<
    'idle' | 'uploading' | 'enqueueing'
  >('idle')
  const [uploadedCount, setUploadedCount] = useState(0)
  const [error, setError] = useState<string | null>(initialToast)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  // BUG-015 — split the single hidden input into two so users can pick
  // EITHER the live camera (`capture="environment"`) OR the existing
  // photo library (no `capture` attr — iOS/Android then show the
  // standard photo-picker). A single input with `capture` set forces
  // mobile browsers straight into the camera and hides the gallery.
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)

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
          t('imports.photoPage.errors.mimeReject', {
            defaultValue:
              'Nur JPG, PNG oder WebP werden unterstützt. Bitte HEIC vor dem Import als JPG/PNG speichern.',
          }),
        )
        return
      }
      if (f.size > MAX_BYTES) {
        setError(
          t('imports.photoPage.errors.tooLargeTemplate', {
            name: f.name,
            defaultValue: `"${f.name}" ist größer als 5 MB.`,
          }),
        )
        return
      }
    }
    if (files.length + list.length > MAX_PHOTOS) {
      setError(
        t('imports.photoPage.errors.maxPhotosTemplate', {
          max: MAX_PHOTOS,
          defaultValue: `Maximal ${MAX_PHOTOS} Fotos pro Import.`,
        }),
      )
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
    // Collected so the create-recipe step can adopt the originals
    // onto the saved recipe + the review-form can render the
    // thumbnails before save (BUG-024). We persist {id, url} pairs
    // instead of bare ids so PhotoUploadGrid.preAttached can display
    // each photo with its signed SeaweedFS URL.
    const stagedPhotos: ImportStagedPhotoMemo[] = []
    try {
      // Sequential upload — see module docstring for rationale.
      for (const file of files) {
        const { signedUrl, stagedPhotoId } = await uploadStagedPhoto(file)
        signedUrls.push(signedUrl)
        stagedPhotos.push({ stagedPhotoId, url: signedUrl })
        setUploadedCount(signedUrls.length)
      }
    } catch (err) {
      setUploadPhase('idle')
      // REL-3f — localise via errors.json + drop 5xx leaks.
      setError(classifyMutationError(err).message)
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
      rememberImportStagedPhotos(importId, stagedPhotos)
      navigate(`/rezepte/import/${importId}`, { state: { groupId } })
    } catch (err) {
      setUploadPhase('idle')
      setError(classifyMutationError(err).message)
    }
  }

  async function handleSubmit(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault()
    if (files.length === 0) {
      setError(
        t('imports.photoPage.errors.atLeastOne', {
          defaultValue: 'Bitte füge mindestens ein Foto hinzu.',
        }),
      )
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
        {t('imports.photoPage.kicker', { defaultValue: 'KI-Import' })}
      </div>
      <h1 className="font-serif text-[clamp(28px,6vw,36px)] font-semibold leading-[1.1] tracking-[-0.015em]">
        {t('imports.photoPage.heading', {
          defaultValue: 'Rezept aus Foto importieren',
        })}
      </h1>
      <p className="mt-2 font-serif-body text-[15px] italic leading-[1.5] text-[hsl(var(--muted-foreground))]">
        {t('imports.photoPage.tagline', {
          defaultValue:
            'Fotografiere eine Rezeptkarte oder lade bis zu 10 Bilder hoch — wir erkennen Zutaten und Schritte und du kannst sie vor dem Speichern prüfen.',
        })}
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-8 rounded-[18px] border border-border bg-card p-6 shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
        noValidate
      >
        <label className="flex items-center gap-1.5 text-[13px] font-semibold tracking-[0.01em] text-foreground">
          <Camera className="h-3.5 w-3.5" aria-hidden="true" />
          {t('imports.photoPage.photosLabel', {
            count: files.length,
            max: MAX_PHOTOS,
            defaultValue: `Fotos (${files.length} / ${MAX_PHOTOS})`,
          })}
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
              t={t}
              onRemove={() => handleRemove(index)}
              onMoveUp={() => handleMove(index, -1)}
              onMoveDown={() => handleMove(index, 1)}
              disabled={submitPending}
            />
          ))}

          {!atLimit && (
            <AddSlot
              onClick={() => galleryInputRef.current?.click()}
              disabled={submitPending}
              t={t}
            />
          )}
        </div>

        {/* BUG-015 — explicit camera vs. gallery split. Both inputs share
            the same `handleInputChange` so the staging pipeline is
            identical regardless of source. Only the camera input carries
            `capture="environment"`; the gallery input intentionally OMITS
            it so iOS/Android show the system photo-picker. */}
        <input
          ref={cameraInputRef}
          data-testid="photos-camera-input"
          type="file"
          accept={ACCEPT.join(',')}
          capture="environment"
          multiple
          className="hidden"
          onChange={handleInputChange}
          disabled={submitPending || atLimit}
        />
        <input
          ref={galleryInputRef}
          data-testid="photos-gallery-input"
          type="file"
          accept={ACCEPT.join(',')}
          multiple
          className="hidden"
          onChange={handleInputChange}
          disabled={submitPending || atLimit}
        />

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => cameraInputRef.current?.click()}
            disabled={submitPending || atLimit}
          >
            <Camera className="h-4 w-4" aria-hidden="true" />
            {t('imports.photoPage.cameraCta', { defaultValue: 'Kamera' })}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => galleryInputRef.current?.click()}
            disabled={submitPending || atLimit}
          >
            <ImageIcon className="h-4 w-4" aria-hidden="true" />
            {t('imports.photoPage.galleryCta', {
              defaultValue: 'Fotos auswählen',
            })}
          </Button>
        </div>

        <p className="mt-3 text-[12.5px] text-[hsl(var(--muted-foreground))]">
          {t('imports.photoPage.formats', {
            defaultValue:
              'Unterstützt: JPG, PNG, WebP bis 5 MB. HEIC (iPhone-Standard) bitte vorher als JPG exportieren.',
          })}
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
            {t('imports.photoPage.uploadProgress', {
              count: uploadedCount,
              total: files.length,
              defaultValue: `Fotos werden hochgeladen … (${uploadedCount} / ${files.length})`,
            })}
          </p>
        )}

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate(-1)}
            disabled={submitPending}
          >
            {t('imports.photoPage.cancelCta', { defaultValue: 'Abbrechen' })}
          </Button>
          <Button
            type="submit"
            disabled={submitPending || files.length === 0}
          >
            {uploadPhase === 'uploading'
              ? t('imports.photoPage.uploading', { defaultValue: 'Lädt hoch …' })
              : uploadPhase === 'enqueueing' || enqueue.isPending
                ? t('imports.photoPage.enqueueing', {
                    defaultValue: 'Starte …',
                  })
                : t('imports.photoPage.submitCta', {
                    defaultValue: 'Rezepte extrahieren',
                  })}
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

/**
 * SHARE-1 — pull pre-staged blobs off `location.state.stagedBlobs`
 * and filter them to the same MIME allowlist the interactive picker
 * uses. Runs ONCE via useState's lazy initializer so a remount (e.g.
 * React strict mode, hot reload) doesn't read the same state twice.
 *
 * After consumption we clear `window.history.state` so the state is
 * gone from the next render cycle onwards — a simple null-write is
 * enough because React Router reads through `window.history.state` on
 * every `useLocation()` evaluation.
 *
 * Returns a tuple: the blobs that passed the filter, and a German
 * toast string when at least one blob was dropped (or null when
 * nothing was dropped / nothing was shared). The caller seeds the
 * page's `error` state with the toast.
 */
function useInitialSharedFiles(location: ReturnType<typeof useLocation>) {
  return useState<[File[], string | null]>(() => {
    const raw = (location.state as { stagedBlobs?: unknown } | null)
      ?.stagedBlobs
    if (!Array.isArray(raw) || raw.length === 0) return [[], null]
    const accepted: File[] = []
    let droppedCount = 0
    for (const entry of raw) {
      if (
        entry instanceof File &&
        ACCEPT.includes(entry.type) &&
        entry.size <= MAX_BYTES
      ) {
        accepted.push(entry)
      } else {
        droppedCount += 1
      }
      if (accepted.length >= MAX_PHOTOS) break
    }
    // Clear the router state so a remount doesn't double-stage. Uses
    // window.history directly because React Router's `navigate(..., {
    // state: null })` would push a history entry which breaks the Back
    // button. `replaceState` keeps the URL identical and just strips
    // the state payload.
    if (typeof window !== 'undefined' && window.history.state != null) {
      window.history.replaceState(
        { ...window.history.state, usr: null },
        '',
      )
    }
    // Non-hook fallback: the lazy initializer runs outside the React
    // render tree, so useTranslation() isn't available. Use the i18n
    // singleton (initialised at app bootstrap) when it's ready; fall
    // through to the DE defaultValue otherwise. The REL-3 `bootstrap.ts`
    // init is async, so in very rare cases the Share-Target handoff
    // fires before `isInitialized` flips — the DE fallback keeps the
    // toast readable. REL-3e globalised the test-setup i18n bootstrap,
    // so vitest runs always see `isInitialized === true`.
    const germanFallback = `Format nicht unterstützt — ${droppedCount} Bild${
      droppedCount === 1 ? '' : 'er'
    } übersprungen.`
    const toast =
      droppedCount > 0
        ? i18n.isInitialized
          ? i18n.t('imports.photoPage.errors.sharedSkipped', {
              count: droppedCount,
              defaultValue: germanFallback,
            })
          : germanFallback
        : null
    return [accepted, toast]
  })[0]
}

interface FilledSlotProps {
  url: string
  index: number
  total: number
  t: ReturnType<typeof useTranslation>['t']
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  disabled: boolean
}

function FilledSlot({
  url,
  index,
  total,
  t,
  onRemove,
  onMoveUp,
  onMoveDown,
  disabled,
}: FilledSlotProps) {
  const isFirst = index === 0
  const isLast = index === total - 1
  const n = index + 1
  return (
    <div className="relative aspect-square overflow-hidden rounded-[12px] bg-[hsl(var(--muted))]">
      <img
        src={url}
        alt={t('imports.photoPage.photoAlt', {
          n,
          defaultValue: `Foto ${n}`,
        })}
        className="h-full w-full object-cover"
        loading="lazy"
      />
      {/* Top-right: remove. */}
      <button
        type="button"
        aria-label={t('imports.photoPage.photoRemove', {
          n,
          defaultValue: `Foto ${n} entfernen`,
        })}
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
        {n}
      </span>
      {/* Bottom-right: reorder buttons. Hidden when only one photo — the
          arrows would no-op anyway and the visual noise isn't worth it. */}
      {total > 1 && (
        <div className="absolute bottom-1.5 right-1.5 flex gap-1">
          <button
            type="button"
            aria-label={t('imports.photoPage.photoMoveUp', {
              n,
              defaultValue: `Foto ${n} nach oben verschieben`,
            })}
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
            aria-label={t('imports.photoPage.photoMoveDown', {
              n,
              defaultValue: `Foto ${n} nach unten verschieben`,
            })}
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
  t,
}: {
  onClick: () => void
  disabled: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <button
      type="button"
      aria-label={t('imports.photoPage.addSlotAria', {
        defaultValue: 'Foto hinzufügen',
      })}
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
        {t('imports.photoPage.addSlotLine1', {
          defaultValue: 'Tippen zum Auswählen',
        })}
        <br />
        {t('imports.photoPage.addSlotLine2', {
          defaultValue: 'oder hierhin ziehen',
        })}
      </span>
    </button>
  )
}
