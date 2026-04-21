import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ImageIcon, Trash2, UploadCloud } from 'lucide-react'
import type { ApiError } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { uploadStagedPhoto } from '@/features/imports/stagedPhotoApi'
import { GroupTagsPanel } from '@/features/tagManagement/GroupTagsPanel'
import { GroupMembersAndInvitesPanel } from './GroupMembersAndInvitesPanel'
import { useGroup, useUpdateGroup } from './hooks'

/**
 * BUG-002 + BUG-003 — dedicated settings page for a group.
 *
 * Replaces the previous `EditGroupDialog` modal with a routed page at
 * `/groups/:groupId/settings` that consolidates all group-management
 * surfaces in one place:
 *   - Name + description + default-servings form (the old dialog fields).
 *   - Single-image cover upload (BUG-003): tap to pick a photo, the file
 *     is staged via the existing `POST /api/recipes/photos/staged`
 *     endpoint (re-used for groups — no new backend), then the resulting
 *     signed URL is persisted on the Group via `PUT /api/groups/{id}`
 *     with `coverImageUrl`. Removing the photo just clears the field.
 *   - The existing `<GroupMembersAndInvitesPanel />` is rendered inline
 *     so admins can manage members + invites from the same surface.
 *
 * Admin-only: non-admin members are redirected back to the group detail
 * page (the underlying PUT endpoint already enforces the same check).
 */
const ACCEPT: readonly string[] = ['image/jpeg', 'image/png', 'image/webp']
const MAX_BYTES = 5 * 1024 * 1024
const UNSUPPORTED_TYPE_ERROR = 'Nur JPG, PNG oder WebP unterstützt.'
const FILE_TOO_LARGE_ERROR = 'Das Foto überschreitet das Limit von 5 MB.'

export function GroupSettingsPage() {
  const params = useParams<{ groupId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const groupId = params.groupId ?? ''
  const detail = useGroup(groupId)
  const update = useUpdateGroup(groupId)

  // BUG-020 — when navigated with `#tags` (e.g. via the redirect from
  // `/groups/:id/tags` for old deep-links), smooth-scroll the Tags
  // heading into view once it's mounted. We depend only on
  // `location.hash` (not the full location object) for stability — the
  // effect would otherwise refire on every search-param tweak. The
  // ref-target is the `<h2 id="tags">` further down. No state set
  // here, so `react-hooks/set-state-in-effect` stays clean.
  const tagsHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const hash = location.hash
  useEffect(() => {
    if (hash !== '#tags') return
    if (!detail.isSuccess) return
    const el = tagsHeadingRef.current
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [hash, detail.isSuccess])

  // Form state — initialised from the loaded GroupDetail once available.
  // We use a `set-state-during-render` reconcile (the same pattern
  // PhotoUploadGrid's StagedGrid uses) instead of `useEffect` so the
  // form values are populated on the first render that has data, with
  // no flash of empties. A `seeded` flag prevents a refetch (e.g. after
  // `useUpdateGroup` invalidates the cache) from clobbering an
  // in-progress edit.
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [defaultServings, setDefaultServings] = useState('2')
  const [coverImageUrl, setCoverImageUrl] = useState('')
  const [seeded, setSeeded] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [photoUploading, setPhotoUploading] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  if (!seeded && detail.isSuccess) {
    setName(detail.data.name)
    setDescription(detail.data.description ?? '')
    setDefaultServings(String(detail.data.defaultServings))
    setCoverImageUrl(detail.data.coverImageUrl ?? '')
    setSeeded(true)
  }

  if (!groupId) return <Navigate to="/groups" replace />

  if (detail.isLoading) {
    return (
      <div
        className="mx-auto w-full max-w-[800px] px-5 py-6 md:px-8"
        aria-label="Einstellungen werden geladen"
      >
        <Skeleton className="mb-4 h-5 w-32" />
        <Skeleton className="mb-3 h-8 w-2/3" />
        <Skeleton className="mb-6 h-[180px] w-full rounded-[18px]" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  if (detail.isError) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
        >
          Gruppe konnte nicht geladen werden.
        </p>
        <Link to="/groups" className="mt-4 inline-block text-sm underline">
          Zurück zu den Gruppen
        </Link>
      </main>
    )
  }

  if (!detail.isSuccess) return null

  const group = detail.data
  // Non-admins shouldn't reach this page; bounce them back to the detail
  // view. The PUT endpoint also enforces this server-side.
  if (group.myRole !== 'Admin') {
    return <Navigate to={`/groups/${groupId}`} replace />
  }

  async function handlePhotoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file after a remove
    if (!file) return
    setPhotoError(null)

    if (!ACCEPT.includes(file.type)) {
      setPhotoError(UNSUPPORTED_TYPE_ERROR)
      return
    }
    if (file.size > MAX_BYTES) {
      setPhotoError(FILE_TOO_LARGE_ERROR)
      return
    }

    setPhotoUploading(true)
    try {
      const result = await uploadStagedPhoto(file)
      setCoverImageUrl(result.signedUrl)
    } catch (err) {
      const apiErr = err as ApiError
      setPhotoError(apiErr.message ?? 'Upload fehlgeschlagen.')
    } finally {
      setPhotoUploading(false)
    }
  }

  function handleRemovePhoto() {
    setPhotoError(null)
    setCoverImageUrl('')
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setFormError(null)

    const parsedServings = Number.parseFloat(defaultServings)
    if (Number.isNaN(parsedServings) || parsedServings <= 0) {
      setFormError('Standard-Portionen muss eine positive Zahl sein.')
      return
    }
    if (parsedServings > 20) {
      setFormError('Standard-Portionen darf höchstens 20 sein.')
      return
    }

    try {
      await update.mutateAsync({
        name: name.trim(),
        description: description.trim() === '' ? undefined : description.trim(),
        defaultServings: parsedServings,
        coverImageUrl: coverImageUrl.trim() === '' ? undefined : coverImageUrl.trim(),
      })
      setSavedAt(Date.now())
    } catch (err) {
      const apiErr = err as ApiError
      setFormError(apiErr.message || 'Speichern fehlgeschlagen.')
    }
  }

  return (
    <div className="mx-auto w-full max-w-[800px]">
      {/* Sub-top-nav with back arrow + page title. Same pattern as
          GroupDetailPage so the visual rhythm carries over.
          BUG-032: migrated from `top-[56px] z-20` to
          `top-[var(--topnav-height)] z-10` alongside the other
          sticky sub-navs. */}
      <nav
        className={cn(
          'sticky top-0 z-10 flex items-center gap-2.5 border-b border-border/60 px-4 py-2.5',
          'bg-[hsl(var(--background)/0.88)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background)/0.75)]',
        )}
        aria-label="Einstellungen-Navigation"
      >
        <button
          type="button"
          onClick={() => navigate(`/groups/${groupId}`)}
          aria-label="Zurück"
          className="grid h-10 w-10 place-items-center rounded-[10px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground"
        >
          <ArrowLeft className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0 leading-[1.1]">
          <span className="truncate font-serif text-[18px] font-semibold tracking-[-0.005em]">
            Einstellungen
          </span>
          <span className="truncate text-[11px] text-[hsl(var(--muted-foreground))]">
            {group.name}
          </span>
        </div>
      </nav>

      <main className="space-y-6 px-5 pb-10 pt-5 md:px-8">
        <section
          aria-labelledby="group-photo-heading"
          className="rounded-[18px] border border-border/60 bg-card/60 px-5 py-5 md:px-6 md:py-6"
        >
          <h2
            id="group-photo-heading"
            className="mb-3 font-serif text-[20px] font-semibold tracking-[-0.005em] text-foreground"
          >
            Gruppen-Foto
          </h2>
          <p className="mb-4 text-[13px] text-[hsl(var(--muted-foreground))]">
            Wird im Banner der Gruppe angezeigt.
          </p>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div
              data-testid="group-photo-preview"
              className="relative h-[120px] w-full flex-shrink-0 overflow-hidden rounded-[16px] border border-border/60 bg-[hsl(var(--muted))] sm:h-[140px] sm:w-[200px]"
            >
              {coverImageUrl ? (
                <img
                  src={coverImageUrl}
                  alt="Gruppen-Foto Vorschau"
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-[hsl(var(--muted-foreground))]">
                  <ImageIcon className="h-8 w-8" aria-hidden="true" />
                </div>
              )}
            </div>

            <div className="flex flex-1 flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={photoUploading}
                >
                  <UploadCloud className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  {photoUploading
                    ? 'Wird hochgeladen …'
                    : coverImageUrl
                      ? 'Foto ersetzen'
                      : 'Foto hochladen'}
                </Button>
                {coverImageUrl && !photoUploading && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleRemovePhoto}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    Foto entfernen
                  </Button>
                )}
              </div>
              <p className="text-[12px] text-[hsl(var(--muted-foreground))]">
                JPG, PNG oder WebP — max. 5 MB.
              </p>
              {photoError && (
                <p
                  role="alert"
                  className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
                >
                  {photoError}
                </p>
              )}
            </div>
          </div>

          <input
            ref={fileInputRef}
            data-testid="group-photo-input"
            type="file"
            accept={ACCEPT.join(',')}
            className="hidden"
            onChange={handlePhotoChange}
          />
        </section>

        <section
          aria-labelledby="group-meta-heading"
          className="rounded-[18px] border border-border/60 bg-card/60 px-5 py-5 md:px-6 md:py-6"
        >
          <h2
            id="group-meta-heading"
            className="mb-4 font-serif text-[20px] font-semibold tracking-[-0.005em] text-foreground"
          >
            Allgemein
          </h2>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="settings-group-name">Name</Label>
              <Input
                id="settings-group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="settings-group-description">Beschreibung</Label>
              <Input
                id="settings-group-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="settings-group-default-servings">Standard-Portionen</Label>
              <Input
                id="settings-group-default-servings"
                type="number"
                min="0.5"
                max="20"
                step="0.5"
                value={defaultServings}
                onChange={(e) => setDefaultServings(e.target.value)}
              />
            </div>

            {formError && (
              <p
                role="alert"
                className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
              >
                {formError}
              </p>
            )}

            {savedAt && !formError && !update.isPending && (
              <p
                role="status"
                className="rounded-md bg-[hsl(var(--primary)/0.08)] px-3 py-2 text-sm text-primary ring-1 ring-[hsl(var(--primary)/0.25)]"
              >
                Einstellungen gespeichert.
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button asChild type="button" variant="ghost">
                <Link to={`/groups/${groupId}`}>Zurück</Link>
              </Button>
              <Button type="submit" disabled={update.isPending || photoUploading}>
                {update.isPending ? 'Speichere …' : 'Speichern'}
              </Button>
            </div>
          </form>
        </section>

        <GroupMembersAndInvitesPanel group={group} />

        {/* BUG-020 — tag management used to live behind a separate cog
            button at `/groups/:id/tags`. Folded in here so the group
            owner has a single page for "everything about this group".
            The `id="tags"` is the deep-anchor target for the
            `/groups/:id/tags` → `/settings#tags` redirect (smooth-scroll
            wired in the `useEffect` above). */}
        <section
          aria-labelledby="tags"
          className="rounded-[18px] border border-border/60 bg-card/60 px-5 py-5 md:px-6 md:py-6"
        >
          <h2
            ref={tagsHeadingRef}
            id="tags"
            className="mb-4 font-serif text-[20px] font-semibold tracking-[-0.005em] text-foreground"
          >
            Tags
          </h2>
          <GroupTagsPanel groupId={groupId} />
        </section>
      </main>
    </div>
  )
}
