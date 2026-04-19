import { useEffect, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CalendarDays } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useMyGroups } from '@/features/groups/useMyGroups'
import { toMondayIso } from '@/features/mealplanning/weekGrid'

/**
 * BUG-007: replaces the previous "Wochenplan kommt in Phase 3" placeholder
 * — Phase 3 has shipped (v0.3.7+) and the real plan lives at
 * `/groups/:groupId/mealplan/:weekStart`. This component routes the
 * user to that page based on how many groups they belong to:
 *
 *  - exactly 1 group → redirect straight to its Wochenplan for the
 *    current Monday so the bottom-nav "Wochenplan" tap is one hop.
 *  - multiple groups → render a small picker so they can choose.
 *  - zero groups → show a CTA pointing at `/groups`.
 *  - while loading → spinner placeholders.
 *
 * Kept under `features/stubs/` for git-history continuity even though
 * it no longer stubs anything; renaming is a follow-up cleanup.
 */
export function WochenplanStub() {
  const groupsQuery = useMyGroups()
  const navigate = useNavigate()
  // Memoise the default (empty) array so the effect's `groups` dep isn't
  // reference-unstable on every render when data is still undefined.
  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data])
  const monday = toMondayIso(new Date().toISOString().slice(0, 10))

  // When the user is in exactly one group we don't render anything —
  // we redirect imperatively in an effect so the URL bar shows the
  // real meal-plan deep link (no "/wochenplan" intermediate that
  // would break the back-button).
  useEffect(() => {
    if (groupsQuery.isSuccess && groups.length === 1) {
      const only = groups[0]
      if (only) navigate(`/groups/${only.id}/mealplan/${monday}`, { replace: true })
    }
  }, [groupsQuery.isSuccess, groups, monday, navigate])

  if (groupsQuery.isLoading) {
    return (
      <section
        aria-label="Wochenplan wird geladen"
        className="mx-auto w-full max-w-xl px-5 py-14 md:px-8 md:py-20"
      >
        <Skeleton className="mx-auto h-8 w-48" />
        <Skeleton className="mt-4 h-4 w-64" />
        <Skeleton className="mt-8 h-12 w-full" />
      </section>
    )
  }

  if (groupsQuery.isError) {
    return (
      <section className="mx-auto w-full max-w-xl px-5 py-14 text-center md:px-8 md:py-20">
        <p role="alert" className="text-sm text-red-700">
          Gruppen konnten nicht geladen werden.
        </p>
        <div className="mt-6 flex justify-center">
          <Button asChild size="lg" variant="outline">
            <Link to="/">Zurück zur Startseite</Link>
          </Button>
        </div>
      </section>
    )
  }

  if (groups.length === 0) {
    return (
      <section className="mx-auto w-full max-w-xl px-5 py-14 text-center md:px-8 md:py-20">
        <span
          aria-hidden="true"
          className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary"
        >
          <CalendarDays className="h-8 w-8" strokeWidth={1.6} />
        </span>
        <h1 className="font-serif text-[clamp(26px,6vw,34px)] font-semibold leading-[1.05] tracking-[-0.015em]">
          Noch keine Gruppe
        </h1>
        <p className="mt-3 font-serif-body text-[15px] italic leading-[1.55] text-muted-foreground">
          Du bist noch in keiner Gruppe. Lege eine an oder lass dich einladen.
        </p>
        <div className="mt-8 flex justify-center gap-2">
          <Button asChild size="lg">
            <Link to="/groups">Zu den Gruppen</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/">Zur Startseite</Link>
          </Button>
        </div>
      </section>
    )
  }

  if (groups.length === 1) {
    // Effect above already pushed the redirect; render nothing in the
    // intermediate frame so the layout doesn't flash a placeholder.
    return null
  }

  // Multi-group picker. Sorted alphabetically so the order is stable
  // across re-renders — the API returns groups in createdAt order which
  // is fine but unintuitive when scanning a long list visually.
  const sorted = [...groups].sort((a, b) => a.name.localeCompare(b.name, 'de'))
  return (
    <section className="mx-auto w-full max-w-xl px-5 py-12 md:px-8 md:py-16">
      <header className="mb-6 text-center">
        <span
          aria-hidden="true"
          className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"
        >
          <CalendarDays className="h-7 w-7" strokeWidth={1.6} />
        </span>
        <h1 className="font-serif text-[clamp(24px,5vw,30px)] font-semibold leading-tight tracking-[-0.015em]">
          Wähle eine Gruppe für den Wochenplan
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Du bist in mehreren Gruppen — pick eine aus, um deren Plan zu öffnen.
        </p>
      </header>
      <ul className="space-y-2">
        {sorted.map((g) => (
          <li key={g.id}>
            <Link
              to={`/groups/${g.id}/mealplan/${monday}`}
              className="flex items-center justify-between gap-3 rounded-[12px] border border-border bg-card px-4 py-3 text-foreground transition-colors hover:border-[hsl(var(--primary))] hover:bg-primary/5"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{g.name}</span>
              <span className="text-xs text-muted-foreground">Wochenplan öffnen</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
