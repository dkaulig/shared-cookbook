import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ApiError, GroupSummary } from '@familien-kochbuch/shared'
import { Sparkles, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMyGroups } from '@/features/groups/useMyGroups'
import { GroupPickerDialog } from '@/features/groups/GroupPickerDialog'
import { CreateGroupDialog } from '@/features/groups/CreateGroupDialog'
import { useFeatures } from '@/features/_shared/useFeatures'
import { useEnqueueUrlImport } from './hooks'
import { rememberImportGroup } from './importGroupMemo'

/**
 * BUG-013 — local state for the cache-hit banner. When the server
 * short-circuits a duplicate URL import, we stash the returned
 * `importId` + the `groupId` we would have used so the "Zum Rezept"
 * button can route exactly where the auto-redirect normally lands, and
 * "Neu extrahieren" can re-submit with `force: true`.
 */
interface CacheHit {
  importId: string
  groupId: string
}

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
  const [searchParams] = useSearchParams()
  // REL-7 — the URL-import surface stays reachable even when AI is off
  // because REL-8's JSON-LD branch runs upstream of the LLM and can
  // handle most food-blog URLs without any credentials. A banner warns
  // the user that AI-powered structuring is unavailable, so imports of
  // FB/IG reels or non-JSON-LD blogs will come back empty. When REL-8
  // lands the backend will gracefully fall back to raw-text pre-fill;
  // until then, non-JSON-LD URLs return the existing empty-import
  // classification.
  const features = useFeatures()
  const aiOff = !features.ai.features.urlImport

  // PV3 — when the progress page sends the user back via the "Neu starten"
  // CTA it appends `?url=<sourceUrl>` so the input is pre-filled. The
  // initialiser only runs once per mount, so typing afterwards still
  // fully owns the input state (a later `?url` change would not clobber
  // what the user typed).
  const prefillUrl = searchParams.get('url') ?? ''
  const urlFromQuery = prefillUrl.length > 0
  const [url, setUrl] = useState<string>(prefillUrl)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  // BUG-013 — when the server reports a cache-hit we render a banner
  // with "Zum bestehenden Rezept" + "Neu extrahieren" CTAs instead of
  // auto-navigating. Cleared on the next submit + after either CTA.
  const [cacheHit, setCacheHit] = useState<CacheHit | null>(null)
  const urlRef = useRef<HTMLInputElement | null>(null)

  // SECURITY (PV3 review): autofocus the URL input ONLY when the field
  // starts empty. Auto-focusing a prefilled input lets a crafted
  // `?url=evil` link + victim-pressing-Enter POST the attacker URL in
  // one keystroke. Requiring an explicit click to focus on prefill
  // gives the user an active moment to inspect the URL first.
  useEffect(() => {
    if (urlFromQuery) return
    urlRef.current?.focus()
  }, [urlFromQuery])

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

  async function importWithGroup(groupId: string, options?: { force?: boolean }) {
    const trimmed = url.trim()
    setError(null)
    setCacheHit(null)
    try {
      const response = await enqueue.mutateAsync({
        url: trimmed,
        groupId,
        ...(options?.force ? { force: true } : {}),
      })
      // Stash groupId keyed by importId so the progress page + the
      // RecipeFormPage prefill know which group to route to, across
      // both fresh and cached import responses. sessionStorage survives
      // soft reloads within the tab; closing the tab drops the mapping,
      // which is fine — the user can reopen /rezepte/import/url.
      rememberImportGroup(response.importId, groupId)

      // BUG-013 — cache-hit path: stop and surface the banner so the
      // user can choose whether to go to the existing recipe or force
      // a fresh extraction. No auto-navigate so the cache behaviour is
      // transparent (the alternative silent redirect would make
      // "I clicked but nothing changed" debuggable only via logs).
      if (response.cached === true) {
        setCacheHit({ importId: response.importId, groupId })
        return
      }

      navigate(`/rezepte/import/${response.importId}`, { state: { groupId } })
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

  // BUG-013 — "Zum bestehenden Rezept": navigate to the cached import's
  // progress page. The progress page's done-branch immediately redirects
  // to the recipe form prefilled from `result`, matching the UX the user
  // would have gotten if the pipeline had just finished.
  function handleGotoCachedImport() {
    if (!cacheHit) return
    const { importId, groupId } = cacheHit
    setCacheHit(null)
    navigate(`/rezepte/import/${importId}`, { state: { groupId } })
  }

  // BUG-013 — "Neu extrahieren": re-submit the same URL with force=true
  // so the server bypasses the cache and runs the full extraction
  // pipeline. We reuse the existing group (the cache-hit was per-user,
  // and the user had already committed to that group on the first POST).
  async function handleForceRefresh() {
    if (!cacheHit) return
    await importWithGroup(cacheHit.groupId, { force: true })
  }

  const submitPending = enqueue.isPending

  return (
    <main className="mx-auto w-full max-w-2xl overflow-hidden px-5 py-8 md:px-8 md:py-12">
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

      {urlFromQuery && (
        <div
          role="status"
          data-testid="import-url-prefill-warning"
          className="mt-6 rounded-[12px] border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <strong>Diese URL stammt aus einem Link.</strong> Bitte prüfe sie,
          bevor du den Import startest.
        </div>
      )}

      {aiOff && (
        <div
          role="status"
          data-testid="import-url-ai-off-banner"
          className="mt-6 rounded-[12px] border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <strong>Diese Instanz läuft ohne KI.</strong> URLs mit Schema.org-
          Rezeptdaten (viele Foodblogs) lassen sich trotzdem importieren;
          bei Reels und Blogs ohne strukturierte Daten bleibt das Ergebnis
          leer und du musst das Rezept manuell ergänzen.
        </div>
      )}

      {cacheHit && (
        <div
          role="status"
          data-testid="import-url-cache-banner"
          className="mt-6 rounded-[12px] border border-sky-300 bg-sky-50 p-4 text-sm text-sky-900"
        >
          <p className="font-semibold">Diese URL wurde bereits importiert.</p>
          <p className="mt-1 text-sky-800">
            Wir haben ein Rezept aus derselben URL in den letzten 7 Tagen
            gefunden. Du kannst es direkt öffnen — oder die Extraktion
            erneut durchlaufen lassen, falls sich das Video geändert hat.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="button" onClick={handleGotoCachedImport}>
              Zum bestehenden Rezept
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void handleForceRefresh()}
              disabled={submitPending}
            >
              {submitPending ? 'Importiere …' : 'Neu extrahieren'}
            </Button>
          </div>
        </div>
      )}

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
          className="mt-2 w-full max-w-full min-w-0 rounded-[12px] border border-[hsl(var(--input))] bg-background px-[13px] py-[11px] text-base leading-[1.4] text-foreground transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[hsl(var(--muted-foreground))]/80 focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25 focus-visible:bg-card"
        />
        <p className="mt-2 text-[12.5px] text-[hsl(var(--muted-foreground))]">
          Unterstützt: YouTube, Instagram Reels, TikTok, Facebook, Foodblogs mit
          Rezept-JSON-LD.
        </p>

        {error && (
          <p
            id="import-url-error"
            role="alert"
            className="mt-4 break-all rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
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
