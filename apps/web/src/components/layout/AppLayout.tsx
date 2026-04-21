import { useEffect } from 'react'
import { Outlet, useMatch } from 'react-router-dom'
import { TopNav } from './TopNav'
import { BottomNav } from './BottomNav'
import { SideRail } from './SideRail'
import { BottomZoneProvider } from './bottomZone'
import { useLiveSync } from '@/features/live/useLiveSync'
import { useBackgroundSyncMessage } from '@/features/offline/useBackgroundSyncMessage'

/**
 * DS3 protected-route shell.
 *
 * Wraps Home, Gruppen, Rezepte, Wochenplan, Profil — every signed-in
 * page. Unlike `AuthLayout` (which ships the parchment background), the
 * app shell keeps a clean cream background so content surfaces have
 * maximum contrast.
 *
 * BUG-039 — hoppr-style layout. The root container is
 * `fixed inset-0 flex flex-col overflow-hidden` so the document itself
 * never scrolls. `<main>` is the sole scroll container (`flex-1
 * min-h-0 overflow-y-auto`); `<TopNav>` / `<BottomNav>` are plain
 * flex-column siblings (`flex-shrink-0`). Because the body doesn't
 * scroll, the browser URL bar never animates — no gap, no jump, no
 * `--viewport-bottom-offset` compensation needed. This replaced the
 * BUG-021 / BUG-023 / BUG-032 / BUG-036 / BUG-037 / BUG-038 positioning
 * patches with a single flexbox structure.
 */
export function AppLayout() {
  // P3-8 — open ONE SignalR connection per authenticated session,
  // shared across every protected page. Per-page subscribes would
  // multiply sockets; hooking it on the layout means the hub opens
  // when the user lands on any protected route and closes when they
  // log out + ProtectedRoute unmounts AppLayout.
  useLiveSync()

  // OFF2 — listen for `fk-mutation-replayed` messages from the
  // service worker's background-sync queue and invalidate affected
  // caches. Mounting here (parallel to useLiveSync) keeps the two
  // transport-layer refresh sources wired exactly once per session.
  useBackgroundSyncMessage()

  // BUG-040 — detect keyboard open via visualViewport shrinkage and
  // set `data-keyboard="open"` on <html> so CSS in index.css can hide
  // the BottomNav while typing. After BUG-039 the root container is
  // `fixed inset-0` (layout-viewport sized); iOS keyboard shrinks the
  // VISUAL viewport from below but the layout viewport doesn't track,
  // so the nav at flex-bottom ends up hidden behind the keyboard. The
  // detection threshold (150 px) is comfortably above the iOS URL-bar
  // retract delta (~50 px) so scroll-triggered chrome animation doesn't
  // false-positive as keyboard.
  useEffect(() => {
    const vv = window.visualViewport
    if (vv == null) return
    const root = document.documentElement

    const THRESHOLD_PX = 150
    let rafId: number | null = null
    const update = () => {
      rafId = null
      const delta = window.innerHeight - vv.height
      if (delta > THRESHOLD_PX) {
        root.dataset.keyboard = 'open'
      } else {
        delete root.dataset.keyboard
      }
    }
    const schedule = () => {
      if (rafId != null) return
      rafId = window.requestAnimationFrame(update)
    }

    vv.addEventListener('resize', schedule)
    return () => {
      if (rafId != null) window.cancelAnimationFrame(rafId)
      vv.removeEventListener('resize', schedule)
      delete root.dataset.keyboard
    }
  }, [])

  // DS5: the recipe detail page has its own floating top bar that
  // overlays the hero photo — suppress the shared TopNav there so we
  // don't end up with two stacked top chrome strips.
  // DS6: the recipe form (create + edit) ships its own sticky top
  // bar (<RecipeFormTopNav />) with the X-cancel + serif title +
  // draft tagline. Suppress the shared TopNav on both form routes.
  const recipeDetailMatch = useMatch('/groups/:groupId/recipes/:recipeId')
  const recipeEditMatch = useMatch('/groups/:groupId/recipes/:recipeId/edit')
  const recipeNewMatch = useMatch('/groups/:groupId/recipes/new')
  // Detail route matches both `/recipes/r1` and `/recipes/new`; we must
  // distinguish by looking at the matched `recipeId` param. We treat the
  // literal "new" as the form-create route, not a detail view.
  const isRecipeDetail = recipeDetailMatch != null && recipeDetailMatch.params.recipeId !== 'new'
  const hideTopNav =
    (isRecipeDetail && recipeEditMatch == null) ||
    recipeEditMatch != null ||
    recipeNewMatch != null

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
      <BottomZoneProvider>
        {!hideTopNav && <TopNav />}
        {/*
         * TABLET-0 — horizontal band between TopNav and BottomNav.
         * SideRail is a flex-sibling of <main> in the tablet zone.
         * `hidden md:flex xl:hidden` collapses the rail outside the
         * 768–1279 px range so <main> reclaims the full width on
         * both mobile and desktop zones with zero layout math —
         * display:none removes it from the flex track entirely.
         */}
        <div className="flex min-h-0 flex-1">
          <SideRail />
          <main
            data-app-shell="true"
            data-testid="app-scroll"
            className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain"
          >
            <Outlet />
          </main>
        </div>
        <BottomNav />
      </BottomZoneProvider>
    </div>
  )
}
