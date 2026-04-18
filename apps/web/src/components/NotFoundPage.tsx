import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

/**
 * DS7 404 fallback.
 *
 * React Router's catch-all (`path="*"`) lands here when the requested
 * route is not registered. Keeps the Warme-Küche voice (warm, a little
 * playful) without being slapstick — the tagline is "Hier kocht niemand"
 * and the subtitle is the honest "Diese Seite gibt's nicht (mehr).".
 *
 * The heading uses Cormorant Garamond (via `font-serif`), the subtitle
 * uses italic Libre Baskerville, and the primary button reuses the
 * shared DS1 Button primitive with the standard `size="lg"` treatment.
 */
export function NotFoundPage() {
  return (
    <main
      className="flex min-h-[60vh] flex-col items-center justify-center bg-background px-6 py-16 text-center"
      data-testid="not-found-page"
    >
      <div className="mx-auto w-full max-w-md">
        <span
          className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-2xl"
          aria-hidden="true"
        >
          🫕
        </span>
        <h1 className="mb-3 font-serif text-[clamp(30px,7vw,44px)] font-semibold leading-[1.05] tracking-[-0.015em] text-foreground">
          404 · Hier kocht niemand
        </h1>
        <p className="mb-8 font-[Libre_Baskerville,serif] text-[15px] italic leading-[1.55] text-muted-foreground">
          Diese Seite gibt's nicht (mehr).
        </p>
        <Button asChild size="lg">
          <Link to="/">Zur Startseite</Link>
        </Button>
      </div>
    </main>
  )
}
