import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useIsMobile, useMediaQuery, MOBILE_QUERY } from './useIsMobile'

/**
 * Helper: install a controllable `window.matchMedia` mock that lets the
 * test fire the change-event listeners on demand. Returns a `setMatch`
 * callable so the test can flip the mobile/desktop state mid-render and
 * assert the hook re-renders.
 */
function installMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(ev: MediaQueryListEvent) => void>()
  let matches = initialMatches
  const mql: MediaQueryList = {
    media: MOBILE_QUERY,
    matches,
    onchange: null,
    addEventListener: (type, listener) => {
      if (type === 'change' && typeof listener === 'function') {
        listeners.add(listener as (ev: MediaQueryListEvent) => void)
      }
    },
    removeEventListener: (type, listener) => {
      if (type === 'change' && typeof listener === 'function') {
        listeners.delete(listener as (ev: MediaQueryListEvent) => void)
      }
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation(() => {
      // Return a fresh MQL whose `matches` getter reflects the
      // outer-scope `matches` flag — this way the hook's first render
      // sees the latest value when the test flips it before mounting.
      return {
        ...mql,
        get matches() {
          return matches
        },
      }
    }),
  })
  return {
    setMatch(next: boolean) {
      matches = next
      const event = { matches: next, media: MOBILE_QUERY } as MediaQueryListEvent
      listeners.forEach((l) => l(event))
    },
    listenerCount: () => listeners.size,
  }
}

describe('useIsMobile / useMediaQuery', () => {
  let originalMatchMedia: typeof window.matchMedia | undefined

  beforeEach(() => {
    originalMatchMedia = window.matchMedia
  })

  afterEach(() => {
    if (originalMatchMedia) {
      window.matchMedia = originalMatchMedia
    }
  })

  it('returns true when the mobile media-query matches at mount', () => {
    installMatchMedia(true)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)
  })

  it('returns false when the mobile media-query does not match', () => {
    installMatchMedia(false)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })

  it('updates when the matchMedia change-event fires', () => {
    const handle = installMatchMedia(false)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)

    act(() => {
      handle.setMatch(true)
    })

    expect(result.current).toBe(true)
  })

  it('removes its listener on unmount', () => {
    const handle = installMatchMedia(true)
    const { unmount } = renderHook(() => useIsMobile())
    expect(handle.listenerCount()).toBe(1)

    unmount()

    expect(handle.listenerCount()).toBe(0)
  })

  it('useMediaQuery accepts a custom query string', () => {
    installMatchMedia(true)
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'))
    // The mock answers true regardless of query, so we mostly assert
    // the hook returns a boolean and respects the mocked initial value.
    expect(typeof result.current).toBe('boolean')
    expect(result.current).toBe(true)
  })

  it('exports MOBILE_QUERY targeting < 768px (Tailwind md: breakpoint)', () => {
    expect(MOBILE_QUERY).toBe('(max-width: 767px)')
  })

  it('returns false in environments without window.matchMedia (SSR-safe)', () => {
    // Simulate the SSR path: matchMedia undefined. The hook must not
    // throw and must default to false (desktop-first fallback).
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    })
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })
})
