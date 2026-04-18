import { Bell, Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ChefHatLogo } from '@/components/brand/ChefHatLogo'
import { useAuth } from '@/features/auth/useAuth'
import { useMyReceivedInvites } from '@/features/groups/hooks'
import { cn } from '@/lib/utils'

/**
 * DS3 top navigation bar.
 *
 * Mirrors `.topnav` in `docs/mockups/warme-kueche-home.html`:
 * - Brand lockup (amber-tile chef-hat + serif name) on the left.
 * - Three "nav actions" on the right: Suchen, Benachrichtigungen (with
 *   a red dot when `useMyReceivedInvites()` > 0), and an avatar chip
 *   whose initial is the signed-in user's displayName[0].
 * - Sticky at `top: 0` with a cream/blur background so scrolled content
 *   floats underneath.
 *
 * Kept intentionally lean: the Suchen button is a placeholder click
 * target today (routes to `/groups` where real search lives). DS7 will
 * upgrade it to a command-palette modal.
 */
export function TopNav() {
  const { user } = useAuth()
  const invites = useMyReceivedInvites()
  const hasInvites = (invites.data?.length ?? 0) > 0
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
          className="grid h-9 w-9 place-items-center rounded-[10px] bg-primary text-primary-foreground shadow-[0_2px_8px_-2px_rgba(180,83,9,0.4)]"
        >
          <ChefHatLogo size={19} />
        </span>
        <span className="font-serif text-[19px] font-semibold leading-none tracking-[-0.005em]">
          Familien-Kochbuch
        </span>
      </Link>

      <nav aria-label="Kontonavigation" className="flex items-center gap-1">
        <Link
          to="/groups"
          aria-label="Suchen"
          className="grid h-10 w-10 place-items-center rounded-[10px] text-muted-foreground transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Search className="h-5 w-5" aria-hidden="true" />
        </Link>
        <button
          type="button"
          aria-label="Benachrichtigungen"
          className="relative grid h-10 w-10 place-items-center rounded-[10px] text-muted-foreground transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Bell className="h-5 w-5" aria-hidden="true" />
          {hasInvites && (
            <span
              data-testid="invites-dot"
              aria-hidden="true"
              className="absolute right-1.5 top-1.5 h-[9px] w-[9px] rounded-full border-2 border-background bg-destructive"
            />
          )}
        </button>
        <Link
          to="/profil"
          aria-label="Dein Profil"
          title={user?.displayName ?? undefined}
          className="ml-1 grid h-9 w-9 place-items-center rounded-full border-2 border-background bg-[linear-gradient(135deg,#fed7aa_0%,#fdba74_100%)] text-[14px] font-semibold text-[#7c2d12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {initial}
        </Link>
      </nav>
    </header>
  )
}
