import { Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ChefHatLogo } from '@/components/brand/ChefHatLogo'
import { NetworkIndicator } from '@/components/layout/NetworkIndicator'
import { useAuth } from '@/features/auth/useAuth'
import { cn } from '@/lib/utils'

/**
 * DS3 top navigation bar (retinted for DS8 Sage Modern, trimmed for BF1).
 *
 * Mirrors `.topnav` in `docs/mockups/variant-a-home.html`:
 * - Brand lockup (sage-tile chef-hat + display name) on the left.
 * - Suchen icon (disabled placeholder) + avatar chip on the right.
 * - Sticky at `top: 0` with a neutral/blur background so scrolled
 *   content floats underneath.
 *
 * BF1 changes:
 * - The Suchen icon used to navigate to `/groups`, which was a confusing
 *   teleport rather than a real search. Render it as a disabled button
 *   with a "bald verfügbar" tooltip until a proper search lands.
 * - The Benachrichtigungen bell had no backing notification feature; it
 *   was removed entirely and will return in Phase 2 alongside the real
 *   notification API.
 */
export function TopNav() {
  const { user } = useAuth()
  const initial = user?.displayName?.trim()?.charAt(0)?.toUpperCase() || '·'

  return (
    <header
      role="banner"
      className={cn(
        'sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3',
        'bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/75',
      )}
    >
      <Link
        to="/"
        className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label="Familien-Kochbuch — Startseite"
      >
        <span
          aria-hidden="true"
          className="grid h-9 w-9 place-items-center rounded-[10px] bg-primary text-primary-foreground shadow-[0_2px_8px_-2px_rgba(79,121,97,0.4)]"
        >
          <ChefHatLogo size={19} />
        </span>
        <span className="font-serif text-[19px] font-semibold leading-none tracking-[-0.005em]">
          Familien-Kochbuch
        </span>
      </Link>

      <nav aria-label="Kontonavigation" className="flex items-center gap-1">
        {/* OFF2 — offline + queued-replay indicator. Silent when online
            and queue is empty so the happy-path UI stays quiet. */}
        <NetworkIndicator />
        <button
          type="button"
          disabled
          aria-label="Suche (bald verfügbar)"
          title="Suche kommt bald"
          className="grid h-10 w-10 cursor-not-allowed place-items-center rounded-[10px] text-muted-foreground/70"
        >
          <Search className="h-5 w-5" aria-hidden="true" />
        </button>
        <Link
          to="/profil"
          aria-label="Dein Profil"
          title={user?.displayName ?? undefined}
          className="ml-1 grid h-9 w-9 place-items-center rounded-full border-2 border-background bg-[linear-gradient(135deg,#c3d4ca_0%,#8daea0_100%)] text-[14px] font-semibold text-[#2b4435] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {initial}
        </Link>
      </nav>
    </header>
  )
}
