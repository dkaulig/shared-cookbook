import { RefreshCw, Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChefHatLogo } from '@/components/brand/ChefHatLogo'
import { NetworkIndicator } from '@/components/layout/NetworkIndicator'
import { LanguageToggle } from '@/components/layout/LanguageToggle'
import { useAuth } from '@/features/auth/useAuth'
import { cn } from '@/lib/utils'

/**
 * DS3 top navigation bar (retinted for DS8 Sage Modern, trimmed for BF1,
 * SEARCH-1 enables the Suche link).
 *
 * Mirrors `.topnav` in `docs/mockups/variant-a-home.html`:
 * - Brand lockup (sage-tile chef-hat + display name) on the left.
 * - Suchen icon (links to `/suche`) + avatar chip on the right.
 * - Sticky at `top: 0` with a neutral/blur background so scrolled
 *   content floats underneath.
 *
 * SEARCH-1 — the Suchen icon is now an active <Link to="/suche">. The
 * pre-SEARCH-1 "bald verfügbar" disabled-button placeholder is gone —
 * global cross-group search is live.
 *
 * BF1 history:
 * - The Benachrichtigungen bell had no backing notification feature; it
 *   was removed entirely and will return in Phase 2 alongside the real
 *   notification API.
 */
export function TopNav() {
  const { user } = useAuth()
  const { t } = useTranslation()
  const initial = user?.displayName?.trim()?.charAt(0)?.toUpperCase() || '·'

  // 2026-04-21 Pull-to-refresh substitute. Standalone-PWAs (Chrome /
  // Safari home-screen installs) disable the browser's native PTR
  // gesture, so users have no way to force a re-fetch. Exposing a
  // manual refresh button here hits the TanStack-Query cache, which
  // triggers every active query to re-fetch from the server. Icon
  // rotates while any query is pending to give the user feedback.
  const queryClient = useQueryClient()
  const isFetching = useIsFetching() > 0
  const handleRefresh = () => {
    void queryClient.invalidateQueries()
  }

  return (
    <header
      role="banner"
      className={cn(
        // BUG-040 — `pt-safe` clears the iOS status-bar overlay in
        // installed-PWA standalone mode. Without it, on notch devices
        // the first ~47 px of the TopNav sits behind the translucent
        // status bar, so the clickable content (logo + home-link) is
        // pushed up against / partly behind the notch. In browser tabs
        // and on non-notch devices `env(safe-area-inset-top)` = 0, so
        // this is a no-op.
        'sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3 pt-safe',
        'bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/75',
      )}
    >
      <Link
        to="/"
        className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label={t('a11y.brandHome', {
          defaultValue: 'Familien-Kochbuch — Startseite',
        })}
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

      <nav
        aria-label={t('a11y.accountNav', { defaultValue: 'Kontonavigation' })}
        className="flex items-center gap-1"
      >
        {/* OFF2 — offline + queued-replay indicator. Silent when online
            and queue is empty so the happy-path UI stays quiet. */}
        <NetworkIndicator />
        <button
          type="button"
          aria-label={t('a11y.refreshPage', {
            defaultValue: 'Seite aktualisieren',
          })}
          title={t('common.retry', { defaultValue: 'Aktualisieren' })}
          onClick={handleRefresh}
          className="grid h-10 w-10 place-items-center rounded-[10px] text-muted-foreground transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <RefreshCw
            className={cn('h-5 w-5', isFetching && 'animate-spin')}
            aria-hidden="true"
          />
        </button>
        <Link
          to="/suche"
          aria-label={t('nav.search', { defaultValue: 'Suche' })}
          title={t('a11y.searchRecipes', { defaultValue: 'Rezepte suchen' })}
          className="grid h-10 w-10 place-items-center rounded-[10px] text-muted-foreground transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Search className="h-5 w-5" aria-hidden="true" />
        </Link>
        {/* REL-3 — language switcher: DE ↔ EN, persisted to
            localStorage via i18next-browser-languagedetector. */}
        <LanguageToggle />
        <Link
          to="/profil"
          aria-label={t('a11y.yourProfile', { defaultValue: 'Dein Profil' })}
          title={user?.displayName ?? undefined}
          className="ml-1 grid h-9 w-9 place-items-center rounded-full border-2 border-background bg-[linear-gradient(135deg,#c3d4ca_0%,#8daea0_100%)] text-[14px] font-semibold text-[#2b4435] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {initial}
        </Link>
      </nav>
    </header>
  )
}
