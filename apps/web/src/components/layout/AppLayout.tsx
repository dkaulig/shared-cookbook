import { useEffect } from 'react'
import { Outlet, useMatch } from 'react-router-dom'
import { TopNav } from './TopNav'
import { BottomNav } from './BottomNav'
import { useLiveSync } from '@/features/live/useLiveSync'

/**
 * DS3 protected-route shell.
 *
 * Wraps Home, Gruppen, Rezepte, Wochenplan, Profil — every signed-in
 * page. Unlike `AuthLayout` (which ships the parchment background), the
 * app shell keeps a clean cream background so content surfaces have
 * maximum contrast.
 *
 * Structure, left-to-right down the page:
 *   - `<TopNav />` — sticky, brand + actions (suppressed on the recipe
 *                    detail page per DS5: that route owns its own
 *                    scroll-aware top bar over the hero).
 *   - `<main>`     — routed child via `<Outlet />`; padded at the bottom
 *                    so content scrolls above the fixed `<BottomNav />`.
 *   - `<BottomNav />` — fixed, mobile-only (`md:hidden`). Desktop polish
 *                       with a side or top expansion lands in DS7.
 */
export function AppLayout() {
  // P3-8 — open ONE SignalR connection per authenticated session,
  // shared across every protected page. Per-page subscribes would
  // multiply sockets; hooking it on the layout means the hub opens
  // when the user lands on any protected route and closes when they
  // log out + ProtectedRoute unmounts AppLayout.
  useLiveSync()

  // BUG-023 — keep `--viewport-bottom-offset` in sync with the visual
  // viewport so backdrop-blur'd fixed-bottom chrome (BottomNav,
  // RecipeActionBar) follows iOS/Chrome's retracting toolbar instead of
  // leaving a transparent gap above the new visual bottom edge.
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--viewport-bottom-offset', '0px')

    const vv = window.visualViewport
    if (vv == null) return

    let rafId: number | null = null
    const update = () => {
      rafId = null
      const offset = Math.max(0, window.innerHeight - (vv.height ?? window.innerHeight))
      root.style.setProperty('--viewport-bottom-offset', `${offset}px`)
    }
    const schedule = () => {
      if (rafId != null) return
      rafId = window.requestAnimationFrame(update)
    }

    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    return () => {
      if (rafId != null) window.cancelAnimationFrame(rafId)
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
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
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      {!hideTopNav && <TopNav />}
      <main
        data-app-shell="true"
        className="relative flex-1 pb-[calc(88px+env(safe-area-inset-bottom,0px))] md:pb-10"
      >
        <Outlet />
      </main>
      <BottomNav />
    </div>
  )
}
