import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const registerSWMock = vi.fn()
vi.mock('virtual:pwa-register', () => ({
  registerSW: registerSWMock,
}))

describe('<PwaUpdatePrompt />', () => {
  beforeEach(() => {
    registerSWMock.mockReset()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('renders nothing until onNeedRefresh fires', async () => {
    // Captured when the component mounts and calls registerSW internally.
    let captured: { onNeedRefresh?: () => void; onOfflineReady?: () => void } = {}
    registerSWMock.mockImplementation((opts: typeof captured) => {
      captured = opts
      return vi.fn()
    })

    const { PwaUpdatePrompt } = await import('./PwaUpdatePrompt')
    render(<PwaUpdatePrompt />)

    expect(screen.queryByRole('alert')).toBeNull()

    // Trigger the SW-registered "update available" signal.
    captured.onNeedRefresh?.()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(
      screen.getByText(/Neue Version verfügbar/i),
    ).toBeInTheDocument()
  })

  it('calls updateSW when the reload button is clicked', async () => {
    const updateSW = vi.fn()
    let captured: { onNeedRefresh?: () => void } = {}
    registerSWMock.mockImplementation((opts: typeof captured) => {
      captured = opts
      return updateSW
    })

    const { PwaUpdatePrompt } = await import('./PwaUpdatePrompt')
    render(<PwaUpdatePrompt />)
    captured.onNeedRefresh?.()

    const button = await screen.findByRole('button', { name: /Neu laden/i })
    await userEvent.click(button)

    expect(updateSW).toHaveBeenCalledTimes(1)
    // The plugin signature is updateSW(true) to trigger the reload.
    expect(updateSW).toHaveBeenCalledWith(true)
  })
})
