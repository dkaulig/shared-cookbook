import { useEffect, useState } from 'react'

/**
 * Tailwind's `md:` breakpoint kicks in at 768 px (`min-width: 768px`).
 * Anything below it is the mobile layout — we therefore key the
 * mobile-vs-desktop hook off `(max-width: 767px)` so the JavaScript
 * branch stays in lock-step with the CSS one rendered by `md:hidden` /
 * `hidden md:grid` utility classes.
 */
export const MOBILE_QUERY = '(max-width: 767px)'

/**
 * Subscribe to a `MediaQueryList` and re-render the calling component
 * whenever the match-state flips. Hardened against jsdom + SSR:
 *
 *   - Falls back to `false` when `window.matchMedia` is missing
 *     (Vitest's jsdom can be configured without it; SSR builds never
 *     have it). Returning `false` keeps the desktop layout — the safer
 *     default for our app, where the grid still scrolls horizontally on
 *     a narrow viewport.
 *   - Uses the modern `addEventListener('change', …)` API. The legacy
 *     `addListener` form is intentionally not used; Safari + Chrome ≥ 14
 *     support the modern form, which is well within our Phase-3 browser
 *     matrix (PRD §10.2).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    if (typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    function handleChange(event: MediaQueryListEvent) {
      setMatches(event.matches)
    }
    mql.addEventListener('change', handleChange)
    return () => {
      mql.removeEventListener('change', handleChange)
    }
  }, [query])

  return matches
}

/**
 * Convenience wrapper: are we currently rendering on a viewport narrower
 * than Tailwind's `md:` breakpoint? Used by `MealPlanPage` to swap the
 * 7×4 desktop grid for a vertical day-stack accordion at mobile sizes
 * (see plan §P3-10 mobile polish).
 */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY)
}
