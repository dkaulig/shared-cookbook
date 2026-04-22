import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Clipboard, X } from 'lucide-react'
import { extractSharedUrl } from '@/features/share/extractSharedUrl'

/**
 * CLIP-0 — clipboard-import banner, iOS PWA fallback for Web Share
 * Target.
 *
 * iOS Safari (WebKit bug #194593, still NEW after 7 years) does not
 * implement `share_target`. The user's flow from Facebook today is
 * "copy link → switch to PWA → paste → import"; this banner replaces
 * the last two steps with a single "Prüfen"-tap.
 *
 * iOS constraints the component honours:
 *   - `navigator.clipboard.readText()` requires a user gesture — we
 *     NEVER auto-read on mount or on `visibilitychange`. Only the
 *     button tap triggers the read.
 *   - No permission prompt is shown when the read happens inside a
 *     click handler; any reject still falls back to the "manuell
 *     einfügen" error state.
 *   - Clipboard contents are attacker-influenceable. `extractSharedUrl`
 *     gates the URL (http(s) only, ≤2000 chars); hostile schemes land
 *     in the no-URL branch, never navigated to, never rendered as HTML.
 *
 * Mount point: {@link AppLayout} guards this component on `/` and
 * `/groups` only — the two landing pages a user hits on app-resume.
 *
 * sessionStorage tracks which clipboard URL the user already consumed
 * so a second tap on the same session doesn't re-prompt. The marker is
 * the URL itself (capped at the 2000-char extractor limit), so a
 * different URL in the clipboard re-arms the banner naturally.
 */
const CONSUMED_URL_KEY = 'clip0:consumed-url'

type ErrorState = 'none' | 'not-a-url' | 'unsupported'

export function ClipboardImportBanner() {
  const navigate = useNavigate()
  const [dismissed, setDismissed] = useState(false)
  const [errorState, setErrorState] = useState<ErrorState>('none')

  // Feature gate: older browsers + jsdom-without-mock return undefined.
  // We evaluate once per render; the reference is stable for the life
  // of the page so no useEffect is needed to listen for it "appearing".
  const hasClipboardApi =
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.readText === 'function'

  // Re-arm on app-resume. iOS fires `visibilitychange` → visible when
  // the user switches back from another app (their primary path into
  // this banner). We only flip `dismissed` back to false — the actual
  // clipboard read still waits for the Prüfen tap (user gesture).
  useEffect(() => {
    if (!hasClipboardApi) return
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        setDismissed(false)
        setErrorState('none')
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [hasClipboardApi])

  if (!hasClipboardApi || dismissed) return null

  async function handleCheck() {
    setErrorState('none')
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch {
      setErrorState('unsupported')
      return
    }
    // Delegate URL extraction + sanitisation to `extractSharedUrl` —
    // same helper the share-target route uses. Wrapping the raw text
    // as `?url=<text>` hits both the direct-sanitise path (bare URL)
    // and the regex fallback (URL embedded in caption text).
    const params = new URLSearchParams()
    params.set('url', text)
    const url = extractSharedUrl(params)
    if (!url) {
      setErrorState('not-a-url')
      return
    }
    // Suppress the banner for the rest of the session — the user has
    // already acted on this clipboard content, no point re-prompting
    // if they navigate back to a landing page.
    sessionStorage.setItem(CONSUMED_URL_KEY, url)
    navigate(`/rezepte/import/url?url=${encodeURIComponent(url)}`)
  }

  // Session-wide suppression: once a URL was consumed during this
  // session we hide the banner on subsequent mounts. `sessionStorage`
  // is cleared on tab-close so the banner re-arms for the next visit.
  if (sessionStorage.getItem(CONSUMED_URL_KEY) != null) return null

  return (
    <section
      data-testid="clipboard-import-banner"
      aria-label="Link aus Zwischenablage importieren"
      className="flex items-start gap-3 rounded-[12px] border border-border bg-card p-[12px_14px] shadow-[0_1px_2px_rgba(28,25,23,0.04)] border-l-[3px] border-l-primary"
    >
      <span
        aria-hidden="true"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[hsl(var(--primary)/0.08)] text-primary"
      >
        <Clipboard className="h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm leading-[1.4] text-foreground">
          Link aus Zwischenablage importieren?
        </p>
        {errorState === 'not-a-url' && (
          <p
            role="alert"
            className="mt-1 text-[12.5px] leading-[1.4] text-[hsl(var(--destructive))]"
          >
            Kein Link in der Zwischenablage gefunden.
          </p>
        )}
        {errorState === 'unsupported' && (
          <p
            role="alert"
            className="mt-1 text-[12.5px] leading-[1.4] text-[hsl(var(--destructive))]"
          >
            Zwischenablage nicht verfügbar.{' '}
            <Link
              to="/rezepte/import/url"
              className="font-semibold underline"
            >
              Link manuell einfügen.
            </Link>
          </p>
        )}
        <div className="mt-[8px] flex gap-2">
          <button
            type="button"
            onClick={() => void handleCheck()}
            className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
          >
            Prüfen
          </button>
        </div>
      </div>
      <button
        type="button"
        aria-label="Banner schließen"
        onClick={() => setDismissed(true)}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-[hsl(var(--muted))]"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  )
}
