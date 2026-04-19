import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PhaseStepper } from './PhaseStepper'

/**
 * `useIsMobile` reads `window.matchMedia`. Vitest's jsdom does ship a
 * stub, but the default return of `matches: false` is exactly what we
 * want for the desktop branch; we override per-test when we need to
 * render the collapsed mobile version.
 */
function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

describe('<PhaseStepper />', () => {
  beforeEach(() => {
    mockMatchMedia(false)
  })

  it('renders five ordered steps for the URL import path', () => {
    render(<PhaseStepper currentPhase="queued" phaseProgress={0} source="url" />)
    expect(screen.getByTestId('phase-step-queued')).toBeInTheDocument()
    expect(screen.getByTestId('phase-step-downloading')).toBeInTheDocument()
    expect(screen.getByTestId('phase-step-transcribing')).toBeInTheDocument()
    expect(screen.getByTestId('phase-step-structuring')).toBeInTheDocument()
    expect(screen.getByTestId('phase-step-post_processing')).toBeInTheDocument()
    expect(screen.queryByTestId('phase-step-vision_analysis')).toBeNull()
  })

  it('swaps Transcribing → Foto-Analyse for the photos path', () => {
    render(<PhaseStepper currentPhase="queued" phaseProgress={0} source="photos" />)
    expect(screen.getByTestId('phase-step-vision_analysis')).toBeInTheDocument()
    expect(screen.queryByTestId('phase-step-transcribing')).toBeNull()
  })

  it('marks the current phase with data-state="current" and earlier ones as done', () => {
    render(<PhaseStepper currentPhase="transcribing" phaseProgress={42} />)
    expect(screen.getByTestId('phase-step-queued')).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('phase-step-downloading')).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('phase-step-transcribing')).toHaveAttribute('data-state', 'current')
    expect(screen.getByTestId('phase-step-structuring')).toHaveAttribute('data-state', 'pending')
    expect(screen.getByTestId('phase-step-post_processing')).toHaveAttribute('data-state', 'pending')
  })

  it('treats done/error as final-step current for stepper positioning', () => {
    render(<PhaseStepper currentPhase="done" phaseProgress={100} />)
    expect(screen.getByTestId('phase-step-post_processing')).toHaveAttribute(
      'data-state',
      'current',
    )
  })

  it('collapses to a single-line label + slim bar on mobile', () => {
    mockMatchMedia(true)
    render(<PhaseStepper currentPhase="transcribing" phaseProgress={42} />)
    expect(screen.getByTestId('phase-stepper-mobile')).toBeInTheDocument()
    expect(screen.queryByTestId('phase-stepper-desktop')).toBeNull()
    expect(screen.getByText(/schritt 3 von 5/i)).toBeInTheDocument()
    expect(screen.getByText(/transkription/i)).toBeInTheDocument()
    const bar = screen.getByRole('progressbar', { name: /phasen-fortschritt/i })
    expect(bar).toHaveAttribute('aria-valuenow', '42')
  })

  it('clamps an over-range phaseProgress on mobile so the bar never overflows', () => {
    mockMatchMedia(true)
    render(<PhaseStepper currentPhase="downloading" phaseProgress={150} />)
    const bar = screen.getByRole('progressbar', { name: /phasen-fortschritt/i })
    expect(bar).toHaveAttribute('aria-valuenow', '100')
  })
})
