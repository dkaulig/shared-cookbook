import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * vite-plugin-pwa exposes a virtual `virtual:pwa-register` module that
 * returns a `registerSW` function. We mock the virtual module so the
 * test can assert we forward the lifecycle callbacks without needing
 * a real service-worker runtime.
 */
const registerSWMock = vi.fn()

vi.mock('virtual:pwa-register', () => ({
  registerSW: registerSWMock,
}))

describe('registerPwa()', () => {
  beforeEach(() => {
    registerSWMock.mockReset()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('wires up onNeedRefresh and onOfflineReady callbacks', async () => {
    const { registerPwa } = await import('./registerSW')
    const onUpdate = vi.fn()
    const onReady = vi.fn()

    registerPwa({ onNeedRefresh: onUpdate, onOfflineReady: onReady })

    expect(registerSWMock).toHaveBeenCalledTimes(1)
    const options = registerSWMock.mock.calls[0]![0]
    expect(options.onNeedRefresh).toBeTypeOf('function')
    expect(options.onOfflineReady).toBeTypeOf('function')

    options.onNeedRefresh()
    expect(onUpdate).toHaveBeenCalledTimes(1)

    options.onOfflineReady()
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('returns the updateSW handler provided by the plugin', async () => {
    const updateSW = vi.fn()
    registerSWMock.mockReturnValueOnce(updateSW)

    const { registerPwa } = await import('./registerSW')
    const returned = registerPwa({})

    expect(returned).toBe(updateSW)
  })
})
