import { Outlet } from 'react-router-dom'
import { ChefHatLogo } from '@/components/brand/ChefHatLogo'
import { cn } from '@/lib/utils'

/**
 * Shell layout for every `/login`, `/signup`, `/forgot-password` and
 * `/reset-password` route. Retinted for DS8 Sage Modern:
 *
 *   - Fixed dotted background (pseudo-element on the wrapper, not
 *     `body::before`, so the effect stays scoped to auth routes). The
 *     dot color uses `hsl(var(--primary)/0.06)` so the token swap to
 *     sage cascades automatically.
 *   - Top brand lockup: sage rounded tile with the chef-hat mark,
 *     display brand name, uppercase tagline.
 *   - Body slot (via `<Outlet />`) for the active auth page.
 *   - Subtle privacy footer note.
 *
 * The pattern utility class `auth-parchment` is defined in `index.css`
 * (plain CSS) so Tailwind arbitrary `bg-[radial-gradient(…)]` does not
 * bloat the class string and so the dotted grid can be positioned as a
 * fixed pseudo-element.
 */
export function AuthLayout() {
  return (
    <div
      data-auth-shell="true"
      className={cn(
        'auth-parchment relative flex min-h-dvh flex-col bg-background text-foreground',
      )}
    >
      <div className="relative z-10 mx-auto flex w-full max-w-2xl flex-1 flex-col px-5 py-6 md:px-8 md:py-12">
        <header role="banner" className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="grid h-11 w-11 place-items-center rounded-[14px] bg-primary text-primary-foreground shadow-[0_4px_12px_-4px_rgba(79,121,97,0.45)]"
          >
            <ChefHatLogo size={22} />
          </div>
          <div>
            <div className="font-serif text-[22px] font-semibold leading-tight tracking-[-0.005em]">
              Familien-Kochbuch
            </div>
            <span className="text-[12px] font-medium uppercase tracking-[0.08em] text-[hsl(24_5%_47%)]">
              Seit immer · für uns alle
            </span>
          </div>
        </header>

        <main className="flex flex-1 flex-col">
          <Outlet />
        </main>

        <footer role="contentinfo" className="mt-10 text-center text-xs text-[hsl(24_5%_47%)]">
          © Familien-Kochbuch · privat &amp; Gruppen-gated
        </footer>
      </div>
    </div>
  )
}
