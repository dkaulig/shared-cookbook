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

  // PV3 simplification regression: previously `phaseOrder(done) === 4`
  // which is the same index as post_processing. The stepper then drew
  // a "current" dot on the post_processing slot for a job that was
  // actually finished — a spinner-like treatment on a completed
  // pipeline. Now `done` maps to index 5 (past-final) and the stepper
  // renders ALL five slots as completed with NO "current" marker.
  it('Done: every step is marked completed, no step is "current"', () => {
    render(<PhaseStepper currentPhase="done" phaseProgress={100} />)
    for (const phase of [
      'queued',
      'downloading',
      'transcribing',
      'structuring',
      'post_processing',
    ] as const) {
      expect(screen.getByTestId(`phase-step-${phase}`)).toHaveAttribute(
        'data-state',
        'done',
      )
    }
    // No slot should carry the "current" marker on a finished import.
    const currentSlots = screen.queryAllByRole('listitem').filter(
      (el) => el.getAttribute('data-state') === 'current',
    )
    expect(currentSlots).toHaveLength(0)
  })

  it('Error: marks the attemptedPhase slot with an error state; later slots stay pending', () => {
    render(
      <PhaseStepper
        currentPhase="error"
        phaseProgress={0}
        attemptedPhase="transcribing"
      />,
    )
    expect(screen.getByTestId('phase-step-queued')).toHaveAttribute(
      'data-state',
      'done',
    )
    expect(screen.getByTestId('phase-step-downloading')).toHaveAttribute(
      'data-state',
      'done',
    )
    expect(screen.getByTestId('phase-step-transcribing')).toHaveAttribute(
      'data-state',
      'error',
    )
    expect(screen.getByTestId('phase-step-structuring')).toHaveAttribute(
      'data-state',
      'pending',
    )
    expect(screen.getByTestId('phase-step-post_processing')).toHaveAttribute(
      'data-state',
      'pending',
    )
  })

  it('Error without attemptedPhase falls back to the first slot marker', () => {
    render(<PhaseStepper currentPhase="error" phaseProgress={0} />)
    expect(screen.getByTestId('phase-step-queued')).toHaveAttribute(
      'data-state',
      'error',
    )
    // The following slots must NOT be "current" — error + current on
    // the same render was the source of the prior user-confusing UI.
    const currentSlots = screen.queryAllByRole('listitem').filter(
      (el) => el.getAttribute('data-state') === 'current',
    )
    expect(currentSlots).toHaveLength(0)
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
