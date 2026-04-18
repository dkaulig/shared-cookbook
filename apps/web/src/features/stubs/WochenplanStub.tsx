import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * Placeholder page behind the `/wochenplan` route until Phase 3 ships
 * the real weekly-plan + shopping-list UI. Linked from the bottom-nav
 * so clicks don't land on a 404. Keeps the warm look-and-feel of the
 * rest of the app (serif headline, cream card, muted italic note).
 */
export function WochenplanStub() {
  return (
    <section className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
      <h1 className="font-serif text-[clamp(30px,7vw,40px)] font-semibold leading-[1.05] tracking-[-0.015em]">
        Wochenplan
      </h1>
      <p className="mt-2 font-[Libre_Baskerville,serif] text-[15px] italic leading-[1.5] text-muted-foreground">
        Planen, kochen, staunen — ein gemütlicher Wochenrhythmus kommt bald.
      </p>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Bald verfügbar</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-foreground">
          <p>
            Phase 3 bringt den Wochenplan mit Drag-and-Drop sowie eine automatisch
            erzeugte Einkaufsliste.
          </p>
          <p className="text-muted-foreground">
            Bis dahin kannst du Rezepte direkt in deinen Gruppen verwalten.
          </p>
        </CardContent>
      </Card>
    </section>
  )
}
