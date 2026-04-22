import { useEffect, useState } from 'react'
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import { useSession } from '@/features/auth/useSession'
import { extractSharedUrl } from './extractSharedUrl'
import { deleteSharePayload, readSharePayload } from './sharePayloadStore'

type PhotoState = 'idle' | 'loading' | 'expired'

/**
 * SHARE-0 + SHARE-1 — entry point for iOS / Android PWA share-sheet
 * shares. Single route handles three payload shapes:
 *
 *   1. `?payload-key=<ts>` (SHARE-1) — service worker stashed file
 *      blobs in IndexedDB; read them back, hand them to the photo-
 *      import staging grid via router state, then delete the record.
 *   2. `?url=…` / `?text=…` / `?title=…` (SHARE-0) — extract the first
 *      usable http(s) URL and redirect into the URL-import flow.
 *   3. None of the above → German empty-state.
 *
 * Unauthenticated users always hit `/login?next=/share-target?…` first
 * so the share payload survives login.
 *
 * Security: the payload is attacker-controlled. `extractSharedUrl`
 * gates the URL branch; `readSharePayload` only returns blobs the SW
 * itself wrote (the `payload-key` is a timestamp chosen by the SW,
 * not the caller — a guessed key at best reads another recent share
 * the same user already consumed). File blobs go to the photo-import
 * pipeline, never rendered as HTML.
 */
export function ShareTargetPage() {
  const { status } = useSession()
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()

  const sharedUrl = extractSharedUrl(searchParams)
  const payloadKeyRaw = searchParams.get('payload-key')
  const payloadKey =
    payloadKeyRaw != null && /^\d+$/.test(payloadKeyRaw)
      ? Number(payloadKeyRaw)
      : null
  const [photoState, setPhotoState] = useState<PhotoState>(
    payloadKey != null ? 'loading' : 'idle',
  )

  // SHARE-0 — URL payload branch. Unchanged from the original route.
  useEffect(() => {
    if (status !== 'authenticated' || sharedUrl == null) return
    navigate(`/rezepte/import/url?url=${encodeURIComponent(sharedUrl)}`, {
      replace: true,
    })
  }, [status, sharedUrl, navigate])

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

  // Loading OR authenticated-with-URL OR authenticated-with-payload-key:
  // one of the effects is firing the redirect; show a neutral busy-
  // state so we don't flash the error UI for a frame.
  if (
    status === 'loading' ||
    sharedUrl != null ||
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
