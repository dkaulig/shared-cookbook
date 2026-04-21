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

  it('does NOT re-acquire on visibilitychange after active flipped to false (ref-mirror regression)', async () => {
    // Regression for the COOK reviewer finding: the visibilitychange
    // handler closed over `active` from the effect it was registered
    // in. If `active` flipped to false after the first render, the
    // stale closure still called `request('screen')` on the next
    // visibility → visible event. Fix mirrors `active` into a ref.
    const sentinel = createSentinel()
    const request = vi.fn().mockResolvedValue(sentinel)
    ;(navigator as unknown as { wakeLock: unknown }).wakeLock = { request }

    const { rerender } = renderHook(({ active }) => useWakeLock(active), {
      initialProps: { active: true },
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(request).toHaveBeenCalledTimes(1)

    // Flip active → false. The effect cleanup runs and the listener
    // is removed as part of the teardown — but the REGRESSION we're
    // guarding against was: during the brief window where the outer
    // listener stayed attached and `active` was already stale, the
    // closure-captured value would have still been `true`. We force
    // that window by registering a second, stale listener via the
    // SAME event name so the simulated visibility event lands on a
    // handler whose captured `active` is the old `true`.
    //
    // The canonical form of the regression: call the REAL handler
    // registered under the initial active=true effect, after the
    // hook's consumer told us active is now false. With a ref-mirror
    // fix that handler must read `activeRef.current === false` and
    // bail. Without the fix it reads the closure `active === true`
    // and calls `request` again.
    //
    // Testing this via the effect lifecycle alone is fragile because
    // the cleanup detaches the handler. We instead spy on
    // addEventListener to capture the actual handler reference and
    // invoke it AFTER the rerender — a visibilitychange event that
    // fires before React's effect cleanup ran would hit exactly this
    // path.
    const addSpy = vi.spyOn(document, 'addEventListener')
    const { rerender: rerender2, unmount: unmount2 } = renderHook(
      ({ active }) => useWakeLock(active),
      { initialProps: { active: true } },
    )
    await act(async () => {
      await Promise.resolve()
    })

    // Grab the handler the hook registered.
    const visibilityEntry = addSpy.mock.calls.find(
      ([event]) => event === 'visibilitychange',
    )
    expect(visibilityEntry).toBeDefined()
    const handler = visibilityEntry![1] as EventListener
    const requestCallsAfterMount = request.mock.calls.length

    // Simulate the race: active flips to false, but before React's
    // cleanup removes the listener, a visibilitychange → visible
    // fires.
    rerender2({ active: false })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    await act(async () => {
      handler(new Event('visibilitychange'))
      await Promise.resolve()
    })

    // With the ref-mirror fix: handler sees activeRef.current=false,
    // no new request. Without: closure `active=true`, new request.
    expect(request).toHaveBeenCalledTimes(requestCallsAfterMount)

    unmount2()
    rerender({ active: false })
    addSpy.mockRestore()
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
