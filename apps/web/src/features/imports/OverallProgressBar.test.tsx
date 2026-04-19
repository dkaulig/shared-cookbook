import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OverallProgressBar } from './OverallProgressBar'

describe('<OverallProgressBar />', () => {
  it('renders with ARIA progressbar semantics + clamps a negative value to 0', () => {
    render(<OverallProgressBar value={-10} label="Warteschlange" />)
    const bar = screen.getByRole('progressbar', { name: /import-fortschritt/i })
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(bar).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByText(/warteschlange/i)).toBeInTheDocument()
    expect(screen.getByText('0%')).toBeInTheDocument()
  })

  it('clamps an over-100 value to 100', () => {
    render(<OverallProgressBar value={150} />)
    const bar = screen.getByRole('progressbar', { name: /import-fortschritt/i })
    expect(bar).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('rounds fractional values to the nearest integer', () => {
    render(<OverallProgressBar value={42.6} />)
    const bar = screen.getByRole('progressbar', { name: /import-fortschritt/i })
    expect(bar).toHaveAttribute('aria-valuenow', '43')
  })

  it('renders percent-only when label is null', () => {
    render(<OverallProgressBar value={25} label={null} />)
    expect(screen.getByText('25%')).toBeInTheDocument()
  })
})

describe('<RetryIndicator />', () => {
  // Colocated so the indicator's two states (hidden / visible) get
  // covered without dragging out another file; the component is small
  // enough to justify sharing a suite.
  it('renders nothing on the first attempt', async () => {
    const { RetryIndicator } = await import('./RetryIndicator')
    const { container } = render(<RetryIndicator attemptNumber={1} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders "Erneuter Versuch 2/3" on retry attempts', async () => {
    const { RetryIndicator } = await import('./RetryIndicator')
    render(<RetryIndicator attemptNumber={2} />)
    expect(screen.getByTestId('retry-indicator')).toHaveTextContent(
      /erneuter versuch 2\/3/i,
    )
  })

  it('honours a custom maxAttempts', async () => {
    const { RetryIndicator } = await import('./RetryIndicator')
    render(<RetryIndicator attemptNumber={3} maxAttempts={5} />)
    expect(screen.getByTestId('retry-indicator')).toHaveTextContent(
      /erneuter versuch 3\/5/i,
    )
  })
})

describe('<StaleBanner />', () => {
  it('renders nothing when lastProgressAt is missing', async () => {
    const { StaleBanner } = await import('./StaleBanner')
    const { container } = render(<StaleBanner lastProgressAt={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when lastProgressAt is fresh (<2 min)', async () => {
    const { StaleBanner } = await import('./StaleBanner')
    const { container } = render(
      <StaleBanner
        lastProgressAt="2026-04-19T12:00:00Z"
        nowMs={Date.parse('2026-04-19T12:01:00Z')}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the amber banner when lastProgressAt is >2 min old', async () => {
    const { StaleBanner } = await import('./StaleBanner')
    render(
      <StaleBanner
        lastProgressAt="2026-04-19T12:00:00Z"
        nowMs={Date.parse('2026-04-19T12:03:00Z')}
      />,
    )
    expect(screen.getByTestId('stale-banner')).toHaveTextContent(
      /import reagiert nicht/i,
    )
  })

  it('renders nothing for an unparseable timestamp (defensive)', async () => {
    const { StaleBanner } = await import('./StaleBanner')
    const { container } = render(<StaleBanner lastProgressAt="nope" />)
    expect(container).toBeEmptyDOMElement()
  })
})
