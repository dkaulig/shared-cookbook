import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

function Exploder(): never {
  throw new Error('kaboom')
}

describe('<ErrorBoundary />', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // React logs caught errors to stderr; silence it here so the suite
    // stays tidy while still letting assertion failures surface.
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>happy path</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('happy path')).toBeInTheDocument()
  })

  it('renders the German fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <Exploder />
      </ErrorBoundary>,
    )
    expect(
      screen.getByText(/Ups, da ist etwas schief gelaufen/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Neu laden/i })).toBeInTheDocument()
  })

  it('calls window.location.reload() when the reload button is clicked', async () => {
    const reload = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...original, reload },
    })

    render(
      <ErrorBoundary>
        <Exploder />
      </ErrorBoundary>,
    )

    await userEvent.click(screen.getByRole('button', { name: /Neu laden/i }))
    expect(reload).toHaveBeenCalledTimes(1)

    // Restore so sibling tests aren't affected.
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: original,
    })
  })
})
