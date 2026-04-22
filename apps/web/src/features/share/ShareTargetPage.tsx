import { useEffect } from 'react'
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import { useSession } from '@/features/auth/useSession'
import { extractSharedUrl } from './extractSharedUrl'

/**
 * SHARE-0 — entry point for iOS / Android PWA share-sheet shares.
 *
 * Manifest declares `/share-target` as the `action`, so when the user
 * taps "Familien-Kochbuch" from Safari / FB / IG / TikTok share sheet,
 * the OS opens `https://<app>/share-target?url=…&text=…&title=…`.
 *
 * Flow:
 *   1. Silent-refresh in flight → "Rezept wird geöffnet …" busy state.
 *   2. Unauthenticated → `/login?next=/share-target?…` so the user
 *      lands back on the share flow after login.
 *   3. Authenticated + usable URL → `replace: true` redirect to
 *      `/rezepte/import/url?url=<extracted>`; Back-button does NOT
 *      return to this transient page.
 *   4. Authenticated + no usable URL (or hostile scheme) → German
 *      error page with a CTA to the manual importer.
 *
 * Security: `extractSharedUrl` rejects non-http(s) schemes and oversize
 * payloads. The page never renders the attacker-controlled URL as
 * HTML, so there's no XSS surface.
 */
export function ShareTargetPage() {
  const { status } = useSession()
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()

  const sharedUrl = extractSharedUrl(searchParams)

  useEffect(() => {
    if (status !== 'authenticated' || sharedUrl == null) return
    navigate(`/rezepte/import/url?url=${encodeURIComponent(sharedUrl)}`, {
      replace: true,
    })
  }, [status, sharedUrl, navigate])

  if (status === 'anonymous') {
    const next = `/share-target${location.search}`
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }

  // Loading OR authenticated-with-URL: the effect is firing the
  // redirect; show a neutral busy-state so we don't flash the error
  // UI for a frame.
  if (status === 'loading' || sharedUrl != null) {
    return (
      <main
        role="status"
        aria-busy="true"
        aria-live="polite"
        className="flex min-h-dvh items-center justify-center px-5 text-sm text-[hsl(var(--muted-foreground))]"
      >
        Rezept wird geöffnet …
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
