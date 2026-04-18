import { Outlet } from 'react-router-dom'
import { TopNav } from './TopNav'
import { BottomNav } from './BottomNav'

/**
 * DS3 protected-route shell.
 *
 * Wraps Home, Gruppen, Rezepte, Wochenplan, Profil — every signed-in
 * page. Unlike `AuthLayout` (which ships the parchment background), the
 * app shell keeps a clean cream background so content surfaces have
 * maximum contrast.
 *
 * Structure, left-to-right down the page:
 *   - `<TopNav />` — sticky, brand + actions.
 *   - `<main>`     — routed child via `<Outlet />`; padded at the bottom
 *                    so content scrolls above the fixed `<BottomNav />`.
 *   - `<BottomNav />` — fixed, mobile-only (`md:hidden`). Desktop polish
 *                       with a side or top expansion lands in DS7.
 */
export function AppLayout() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <TopNav />
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
