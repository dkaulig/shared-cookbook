import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWakeLock } from './useWakeLock'

/**
 * Minimal fake WakeLockSentinel — the real API returns a sentinel whose
 * `release()` resolves a Promise. We mirror the shape so the hook can
 * call `.release()` without guards.
 */
function createSentinel() {
  const sentinel = {
    release: vi.fn().mockResolvedValue(undefined),
    released: false,
    type: 'screen' as const,
  }
  return sentinel
}

describe('useWakeLock', () => {
  const originalWakeLock = (navigator as unknown as { wakeLock?: unknown }).wakeLock

  afterEach(() => {
    if (originalWakeLock === undefined) {
      delete (navigator as unknown as { wakeLock?: unknown }).wakeLock
    } else {
      ;(navigator as unknown as { wakeLock?: unknown }).wakeLock = originalWakeLock
    }
    vi.restoreAllMocks()
  })

  it('reports supported=false when navigator.wakeLock is undefined', () => {
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock
    const { result } = renderHook(() => useWakeLock(true))
    expect(result.current.supported).toBe(false)
    expect(result.current.granted).toBe(false)
  })

  it('requests a screen wake-lock when active=true on mount', async () => {
    const sentinel = createSentinel()
    const request = vi.fn().mockResolvedValue(sentinel)
    ;(navigator as unknown as { wakeLock: unknown }).wakeLock = { request }

    const { result } = renderHook(() => useWakeLock(true))
    await act(async () => {
      await Promise.resolve()
    })

    expect(request).toHaveBeenCalledWith('screen')
    expect(result.current.supported).toBe(true)
    expect(result.current.granted).toBe(true)
  })

  it('does not request when active=false', async () => {
    const request = vi.fn().mockResolvedValue(createSentinel())
    ;(navigator as unknown as { wakeLock: unknown }).wakeLock = { request }

    renderHook(() => useWakeLock(false))
    await act(async () => {
      await Promise.resolve()
    })

    expect(request).not.toHaveBeenCalled()
  })

  it('releases the lock on unmount', async () => {
    const sentinel = createSentinel()
    const request = vi.fn().mockResolvedValue(sentinel)
    ;(navigator as unknown as { wakeLock: unknown }).wakeLock = { request }

    const { unmount } = renderHook(() => useWakeLock(true))
    await act(async () => {
      await Promise.resolve()
    })

    unmount()
    await act(async () => {
      await Promise.resolve()
    })

    expect(sentinel.release).toHaveBeenCalled()
  })

  it('releases the lock when active flips to false', async () => {
    const sentinel = createSentinel()
    const request = vi.fn().mockResolvedValue(sentinel)
    ;(navigator as unknown as { wakeLock: unknown }).wakeLock = { request }

    const { rerender } = renderHook(({ active }) => useWakeLock(active), {
      initialProps: { active: true },
    })
    await act(async () => {
      await Promise.resolve()
    })

    rerender({ active: false })
    await act(async () => {
      await Promise.resolve()
    })

    expect(sentinel.release).toHaveBeenCalled()
  })

  it('re-acquires the lock on visibilitychange → visible when active', async () => {
    const firstSentinel = createSentinel()
    const secondSentinel = createSentinel()
    const request = vi
      .fn()
      .mockResolvedValueOnce(firstSentinel)
      .mockResolvedValueOnce(secondSentinel)
    ;(navigator as unknown as { wakeLock: unknown }).wakeLock = { request }

    renderHook(() => useWakeLock(true))
    await act(async () => {
      await Promise.resolve()
    })
    expect(request).toHaveBeenCalledTimes(1)

    // Simulate tab hidden then visible — iOS/Android auto-release on hide.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })

    expect(request).toHaveBeenCalledTimes(2)
  })

  it('swallows NotAllowedError gracefully — granted=false, no throw', async () => {
    const err = new DOMException('denied', 'NotAllowedError')
    const request = vi.fn().mockRejectedValue(err)
    ;(navigator as unknown as { wakeLock: unknown }).wakeLock = { request }

    const { result } = renderHook(() => useWakeLock(true))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.supported).toBe(true)
    expect(result.current.granted).toBe(false)
  })
})
