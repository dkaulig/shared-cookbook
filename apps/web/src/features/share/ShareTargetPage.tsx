import { useEffect, useState } from 'react'
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import { Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSession } from '@/features/auth/useSession'
import { useMyGroups } from '@/features/groups/useMyGroups'
import { useEnqueueUrlImport } from '@/features/imports/hooks'
import { MAX_SHARED_URLS, extractSharedUrls } from './extractSharedUrl'
import { deleteSharePayload, readSharePayload } from './sharePayloadStore'

type PhotoState = 'idle' | 'loading' | 'expired'

/**
 * SHARE-0 + SHARE-1 + SHARE-2 — entry point for iOS / Android PWA
 * share-sheet shares. Single route handles four payload shapes:
 *
 *   1. `?payload-key=<ts>` (SHARE-1) — service worker stashed file
 *      blobs in IndexedDB; read them back, hand them to the photo-
 *      import staging grid via router state, then delete the record.
 *   2. exactly one usable URL in `?url=` / `?text=` / `?title=`
 *      (SHARE-0) — silent redirect to the URL-import flow.
 *   3. 2-10 URLs (SHARE-2) — render the multi-URL picker. User picks
 *      one card → redirect to URL-import, or hits "Alle importieren"
 *      to fire N sequential enqueues + land on the import-list page.
 *   4. None of the above (or >10 URLs, or hostile schemes only) →
 *      German empty-state / too-many error.
 *
 * Unauthenticated users always hit `/login?next=/share-target?…` first
 * so the share payload survives login.
 *
 * Security: the payload is attacker-controlled. `extractSharedUrls`
 * gates the URL branch per-URL (http(s) only, ≤2000 chars, 10-item
 * cap); `readSharePayload` only returns blobs the SW itself wrote
 * (the `payload-key` is a timestamp chosen by the SW, not the caller
 * — a guessed key at best reads another recent share the same user
 * already consumed). File blobs go to the photo-import pipeline,
 * never rendered as HTML.
 */
export function ShareTargetPage() {
  const { status } = useSession()
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()

  // SHARE-2 — URL extraction returns up to MAX_SHARED_URLS+1 entries
  // so we can detect "too many" without re-walking. 0 → empty state,
  // 1 → silent redirect, 2..MAX → picker, >MAX → reject.
  const extracted = extractSharedUrls(searchParams)
  const tooManyUrls = extracted.length > MAX_SHARED_URLS
  const sharedUrls = tooManyUrls ? [] : extracted
  const payloadKeyRaw = searchParams.get('payload-key')
  const payloadKey =
    payloadKeyRaw != null && /^\d+$/.test(payloadKeyRaw)
      ? Number(payloadKeyRaw)
      : null
  const [photoState, setPhotoState] = useState<PhotoState>(
    payloadKey != null ? 'loading' : 'idle',
  )

  // SHARE-0 — single-URL silent-redirect branch. Only fires when
  // exactly one URL survived extraction; multi-URL payloads fall
  // through to the picker below.
  const autoRedirectUrl = sharedUrls.length === 1 ? sharedUrls[0]! : null
  useEffect(() => {
    if (status !== 'authenticated' || autoRedirectUrl == null) return
    navigate(
      `/rezepte/import/url?url=${encodeURIComponent(autoRedirectUrl)}`,
      { replace: true },
    )
  }, [status, autoRedirectUrl, navigate])

  // SHARE-1 — file payload branch. Async because IndexedDB reads are
  // promises; we flip to `expired` when the record isn't there (the
  // 5-min TTL already lapsed or the SW never wrote it).
  useEffect(() => {
    if (status !== 'authenticated' || payloadKey == null) return
    let cancelled = false
    void (async () => {
      const blobs = await readSharePayload(payloadKey)
      if (cancelled) return
      if (!blobs || blobs.length === 0) {
        setPhotoState('expired')
        return
      }
      // Delete before navigating so a Back-button on the photo-import
      // page can't re-consume the same record.
      await deleteSharePayload(payloadKey)
      if (cancelled) return
      navigate('/rezepte/import/photos', {
        replace: true,
        state: { stagedBlobs: blobs },
      })
    })()
    return () => {
      cancelled = true
    }
  }, [status, payloadKey, navigate])

  if (status === 'anonymous') {
    const next = `/share-target${location.search}`
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }

  if (photoState === 'expired') {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-5 py-12 text-center">
        <h1 className="font-serif text-2xl font-semibold">
          Bild-Freigabe abgelaufen
        </h1>
        <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">
          Bitte erneut teilen.
        </p>
        <Link
          to="/rezepte/import/photos"
          className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Foto manuell importieren
        </Link>
      </main>
    )
  }

  // SHARE-2 — >10 URLs reject. Attacker / accidental: a caption full
  // of links. Render a bounded error + "Abbrechen" instead of
  // silently taking the first 10 — the user explicitly picks what
  // they meant to share.
  if (tooManyUrls) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-5 py-12 text-center">
        <h1 className="font-serif text-2xl font-semibold">
          Zu viele Links
        </h1>
        <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">
          Maximal 10 Links auf einmal — bitte auswählen.
        </p>
        <Link
          to="/rezepte/import/url"
          className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          URL manuell importieren
        </Link>
      </main>
    )
  }

  // SHARE-2 — 2-10 URLs → render the picker inline.
  if (sharedUrls.length > 1 && status === 'authenticated') {
    return <MultiUrlPicker urls={sharedUrls} />
  }

  // Loading OR authenticated-with-single-URL OR authenticated-with-
  // payload-key: one of the effects is firing the redirect; show a
  // neutral busy-state so we don't flash the error UI for a frame.
  if (
    status === 'loading' ||
    autoRedirectUrl != null ||
    photoState === 'loading'
  ) {
    const label =
      photoState === 'loading'
        ? 'Foto aus Freigabe wird vorbereitet …'
        : 'Rezept wird geöffnet …'
    return (
      <main
        role="status"
        aria-busy="true"
        aria-live="polite"
        className="flex min-h-dvh items-center justify-center px-5 text-sm text-[hsl(var(--muted-foreground))]"
      >
        {label}
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-5 py-12 text-center">
      <h1 className="font-serif text-2xl font-semibold">
        Kein Link in der Freigabe gefunden
      </h1>
      <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">
        Bitte manuell importieren.
      </p>
      <Link
        to="/rezepte/import/url"
        className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        URL manuell importieren
      </Link>
    </main>
  )
}

/**
 * SHARE-2 — inline multi-URL picker.
 *
 * Renders 2-10 URL cards; tapping a card navigates to the single-URL
 * import flow, "Alle importieren (N)" fires N POSTs in parallel via
 * the same enqueue mutation the URL form uses then lands the user on
 * the import-list page where Hangfire-driven progress rows tick down.
 *
 * Group selection: the user's FIRST group is used silently. The
 * picker doesn't try to reproduce `ImportUrlPage`'s group-picker
 * dialog — this is the "fast lane" for someone who just wants to
 * fire off a bunch of imports and go. Users with multiple groups who
 * want to route into a specific one can tap a single card to land on
 * the full URL form (which DOES open the group picker).
 */
function MultiUrlPicker({ urls }: { urls: string[] }) {
  const navigate = useNavigate()
  const groups = useMyGroups()
  const enqueue = useEnqueueUrlImport()
  const [submitError, setSubmitError] = useState<string | null>(null)

  function goSingle(url: string) {
    navigate(`/rezepte/import/url?url=${encodeURIComponent(url)}`, {
      replace: true,
    })
  }

  async function importAll() {
    // Every authenticated user has at least their private collection,
    // so `groups.data` is non-empty once the query settles. While it
    // loads, the button is disabled via `groups.isPending` below.
    const groupId = groups.data?.[0]?.id
    if (!groupId) return
    setSubmitError(null)
    // Fire enqueue mutations in parallel. The server queues per-user
    // so these land on Hangfire without racing; the N cap (≤10) is
    // well below any per-user rate-limit the backend applies.
    const results = await Promise.allSettled(
      urls.map((url) => enqueue.mutateAsync({ url, groupId })),
    )
    const successes = results.filter((r) => r.status === 'fulfilled').length
    if (successes === 0) {
      setSubmitError(
        'Die Imports konnten nicht gestartet werden. Bitte erneut versuchen.',
      )
      return
    }
    navigate('/rezepte/import')
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 py-8">
      <h1 className="font-serif text-[clamp(22px,5vw,28px)] font-semibold leading-[1.15] tracking-[-0.01em]">
        Welches Rezept willst du importieren?
      </h1>
      <p className="mt-2 text-[14px] text-[hsl(var(--muted-foreground))]">
        {urls.length} Links in der Freigabe gefunden. Tippe einen an oder
        starte alle gleichzeitig.
      </p>

      <ul className="mt-6 flex flex-col gap-2">
        {urls.map((url) => (
          <li key={url}>
            <button
              type="button"
              data-testid="share-picker-card"
              onClick={() => goSingle(url)}
              className="flex w-full items-center gap-3 rounded-[14px] border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.04)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <span
                aria-hidden="true"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[hsl(var(--primary)/0.1)] text-primary"
              >
                <Link2 className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground">
                {shortenUrl(url)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {submitError && (
        <p
          role="alert"
          className="mt-4 rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
        >
          {submitError}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => navigate(-1)}
        >
          Abbrechen
        </Button>
        <Button
          type="button"
          onClick={() => void importAll()}
          disabled={enqueue.isPending || groups.isPending}
        >
          {enqueue.isPending
            ? 'Importiere …'
            : `Alle importieren (${urls.length})`}
        </Button>
      </div>
    </main>
  )
}

/**
 * Truncates a URL for the picker card. Hostname + first path segment
 * so "fb.com/share/r/abc123xyz/extra/stuff" reads as "fb.com/share".
 * Mirrors the row-shortener in `ImportListPage`.
 */
function shortenUrl(sourceUrl: string): string {
  try {
    const parsed = new URL(sourceUrl)
    const host = parsed.host.replace(/^www\./, '')
    const segments = parsed.pathname.split('/').filter((s) => s.length > 0)
    if (segments.length === 0) return host
    return `${host}/${segments[0]!.slice(0, 30)}${segments[0]!.length > 30 ? '…' : ''}`
  } catch {
    return sourceUrl
  }
}
