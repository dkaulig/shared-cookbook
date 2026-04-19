import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ApiError, GroupSummary } from '@familien-kochbuch/shared'
import { Sparkles, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMyGroups } from '@/features/groups/useMyGroups'
import { GroupPickerDialog } from '@/features/groups/GroupPickerDialog'
import { CreateGroupDialog } from '@/features/groups/CreateGroupDialog'
import { useEnqueueUrlImport } from './hooks'

/**
 * URL-import entry form — routed at `/rezepte/import/url`.
 *
 * Flow:
 *   1. User pastes a URL into an autofocused input.
 *   2. On submit:
 *      - No groups → open CreateGroupDialog, do nothing else.
 *      - One group → skip the picker, POST straight with that group.
 *      - >1 groups → open GroupPickerDialog; POST on pick.
 *   3. On 202 → navigate to `/rezepte/import/:importId` where the
 *      progress page takes over the polling + review flow.
 *
 * German throughout. The URL is validated as absolute http(s) before
 * we even call the server; the server repeats the validation for
 * hostile callers, but the early check keeps the UX snappy.
 */
export function ImportUrlPage() {
  const navigate = useNavigate()
  const groups = useMyGroups()
  const enqueue = useEnqueueUrlImport()

  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const urlRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    urlRef.current?.focus()
  }, [])

  function validateUrl(raw: string): string | null {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return 'Bitte gib eine URL ein.'
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return 'Die URL muss absolut sein und mit http:// oder https:// beginnen.'
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Die URL muss absolut sein und mit http:// oder https:// beginnen.'
    }
    return null
  }

  async function importWithGroup(groupId: string) {
    const trimmed = url.trim()
    setError(null)
    try {
      const { importId } = await enqueue.mutateAsync({
        url: trimmed,
        groupId,
      })
      navigate(`/rezepte/import/${importId}`)
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message || 'Der Import konnte nicht gestartet werden.')
    }
  }

  async function handleSubmit(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault()
    const urlError = validateUrl(url)
    if (urlError) {
      setError(urlError)
      return
    }
    const list = groups.data ?? []
    if (list.length === 0) {
      // No groups at all — offer to create one. The dialog's onClose
      // brings us back here; once a group exists the user can retry.
      setCreateGroupOpen(true)
      return
    }
    if (list.length === 1) {
      // Single group (typically just the private collection) → skip
      // the picker entirely.
      await importWithGroup(list[0]!.id)
      return
    }
    setPickerOpen(true)
  }

  function handleGroupPick(group: GroupSummary) {
    setPickerOpen(false)
    void importWithGroup(group.id)
  }

  const submitPending = enqueue.isPending

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8 md:px-8 md:py-12">
      <div className="mb-6 flex items-center gap-2 text-[13px] font-medium uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
        <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        KI-Import
      </div>
      <h1 className="font-serif text-[clamp(28px,6vw,36px)] font-semibold leading-[1.1] tracking-[-0.015em]">
        Rezept aus Video importieren
      </h1>
      <p className="mt-2 font-serif-body text-[15px] italic leading-[1.5] text-[hsl(var(--muted-foreground))]">
        Füge eine URL ein (YouTube, Reel, Blog) — wir erkennen das Rezept
        und du kannst es vor dem Speichern prüfen.
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-8 rounded-[18px] border border-border bg-card p-6 shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
        noValidate
      >
        <label
          htmlFor="import-url"
          className="flex items-center gap-1.5 text-[13px] font-semibold tracking-[0.01em] text-foreground"
        >
          <Video className="h-3.5 w-3.5" aria-hidden="true" />
          Video- oder Blog-URL
        </label>
        <input
          ref={urlRef}
          id="import-url"
          name="import-url"
          type="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          aria-invalid={error != null}
          aria-describedby={error ? 'import-url-error' : undefined}
          className="mt-2 w-full rounded-[12px] border border-[hsl(var(--input))] bg-background px-[13px] py-[11px] text-[15px] leading-[1.4] text-foreground transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[hsl(var(--muted-foreground))]/80 focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25 focus-visible:bg-card"
        />
        <p className="mt-2 text-[12.5px] text-[hsl(var(--muted-foreground))]">
          Unterstützt: YouTube, Instagram Reels, TikTok, Facebook, Foodblogs mit
          Rezept-JSON-LD.
        </p>

        {error && (
          <p
            id="import-url-error"
            role="alert"
            className="mt-4 rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
          >
            {error}
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
          <Button type="submit" disabled={submitPending || url.trim().length === 0}>
            {submitPending ? 'Importiere …' : 'Rezept importieren'}
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
