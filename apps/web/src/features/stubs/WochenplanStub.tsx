import { Calendar } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

/**
 * Placeholder page behind the `/wochenplan` route until Phase 3 ships
 * the real weekly-plan + shopping-list UI. Linked from the bottom-nav
 * so clicks don't land on a 404.
 *
 * DS7 polish: replace the previous generic "Bald verfügbar" card with
 * a deliberate "Wochenplan kommt in Phase 3" headline, an italic
 * tagline enumerating the planned scope, a subtle Lucide calendar
 * illustration, and a clear "Zurück zur Startseite" button so users
 * who land here by curiosity have an obvious way back.
 */
export function WochenplanStub() {
  return (
    <section className="mx-auto w-full max-w-xl px-5 py-14 text-center md:px-8 md:py-20">
      <span
        data-testid="wochenplan-stub-illustration"
        aria-hidden="true"
        className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary"
      >
        <Calendar className="h-8 w-8" strokeWidth={1.6} />
      </span>
      <h1 className="font-serif text-[clamp(30px,7vw,40px)] font-semibold leading-[1.05] tracking-[-0.015em]">
        Wochenplan kommt in Phase 3
      </h1>
      <p className="mt-3 font-serif-body text-[15px] italic leading-[1.55] text-muted-foreground">
        Rezepte planen. Einkaufsliste generieren. Saisonale Vorschläge.
      </p>

      <div className="mt-8 flex justify-center">
        <Button asChild size="lg" variant="outline">
          <Link to="/">Zurück zur Startseite</Link>
        </Button>
      </div>
    </section>
  )
}
