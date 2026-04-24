import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

/**
 * DS7 404 fallback.
 *
 * React Router's catch-all (`path="*"`) lands here when the requested
 * route is not registered. Keeps the app voice warm and a little playful
 * — the tagline is "Hier kocht niemand" and the subtitle is the honest
 * "Diese Seite gibt's nicht (mehr).".
 *
 * DS8 Sage Modern typography: headline uses `font-serif`, subtitle uses
 * `font-serif-body` italic — both tokens resolve to Inter so the page
 * reads cleanly in the Sage Modern skin.
 */
export function NotFoundPage() {
  const { t } = useTranslation()
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
          {t('notFound.title', { defaultValue: '404 · Hier kocht niemand' })}
        </h1>
        <p className="mb-8 font-serif-body text-[15px] italic leading-[1.55] text-muted-foreground">
          {t('notFound.body', {
            defaultValue: "Diese Seite gibt's nicht (mehr).",
          })}
        </p>
        <Button asChild size="lg">
          <Link to="/">
            {t('notFound.home', { defaultValue: 'Zur Startseite' })}
          </Link>
        </Button>
      </div>
    </main>
  )
}
