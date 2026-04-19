import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RecipeImportDto } from '@familien-kochbuch/shared'
import { PhaseDetailCard } from './PhaseDetailCard'

type Payload = Pick<
  RecipeImportDto,
  | 'bytesDownloaded'
  | 'bytesTotal'
  | 'segmentsDone'
  | 'segmentsTotal'
  | 'createdAt'
  | 'errorMessage'
  | 'progressLabel'
>

const EMPTY: Payload = {
  bytesDownloaded: null,
  bytesTotal: null,
  segmentsDone: null,
  segmentsTotal: null,
  createdAt: '2026-04-19T12:00:00Z',
  errorMessage: null,
  progressLabel: null,
}

describe('<PhaseDetailCard />', () => {
  it('renders the queued copy + spinner', () => {
    render(<PhaseDetailCard phase="queued" payload={EMPTY} />)
    expect(screen.getByText(/warteschlange/i)).toBeInTheDocument()
    expect(screen.getByTestId('phase-detail-queued')).toBeInTheDocument()
  })

  it('renders "3,4 von 12,7 MB (27%)" for downloading with byte counters', () => {
    render(
      <PhaseDetailCard
        phase="downloading"
        payload={{ ...EMPTY, bytesDownloaded: 3_400_000, bytesTotal: 12_700_000 }}
      />,
    )
    expect(screen.getByText(/video wird heruntergeladen/i)).toBeInTheDocument()
    // 3.4/12.7 ≈ 0.267 → 27%
    expect(screen.getByText(/3,4 MB.*von.*12,7 MB.*\(27%\)/i)).toBeInTheDocument()
  })

  it('hides the bytes sub-line when bytesTotal is missing', () => {
    render(
      <PhaseDetailCard
        phase="downloading"
        payload={{ ...EMPTY, bytesDownloaded: 3_400_000, bytesTotal: null }}
      />,
    )
    expect(screen.queryByText(/MB/)).toBeNull()
  })

  it('renders the transcribing copy with segments (no ETA when <3 segments done)', () => {
    render(
      <PhaseDetailCard
        phase="transcribing"
        payload={{
          ...EMPTY,
          segmentsDone: 1,
          segmentsTotal: 20,
          createdAt: '2026-04-19T12:00:00Z',
        }}
      />,
    )
    expect(screen.getByText(/audio wird transkribiert/i)).toBeInTheDocument()
    expect(screen.getByText(/segment 1 von 20/i)).toBeInTheDocument()
    expect(screen.queryByText(/noch ~/)).toBeNull()
  })

  it('renders an ETA once more than two segments have completed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-19T12:00:20Z'))
    render(
      <PhaseDetailCard
        phase="transcribing"
        payload={{
          ...EMPTY,
          segmentsDone: 5,
          segmentsTotal: 10,
          createdAt: '2026-04-19T12:00:00Z',
        }}
      />,
    )
    expect(screen.getByText(/segment 5 von 10 — noch ~20s/i)).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('renders Structuring, PostProcessing and VisionAnalysis with their distinct copy', () => {
    const cases: Array<[
      'structuring' | 'post_processing' | 'vision_analysis',
      RegExp,
    ]> = [
      ['structuring', /rezept wird strukturiert \(azure openai\)/i],
      ['post_processing', /nachverarbeitung/i],
      ['vision_analysis', /fotos werden analysiert \(azure vision\)/i],
    ]
    for (const [phase, pattern] of cases) {
      const { unmount } = render(<PhaseDetailCard phase={phase} payload={EMPTY} />)
      expect(screen.getByText(pattern)).toBeInTheDocument()
      unmount()
    }
  })

  it('renders the Done flourish', () => {
    render(<PhaseDetailCard phase="done" payload={EMPTY} />)
    expect(screen.getByText(/fertig — leite weiter/i)).toBeInTheDocument()
  })

  it('renders the server-provided errorMessage in the Error card + wires onRetry', async () => {
    const onRetry = vi.fn()
    render(
      <PhaseDetailCard
        phase="error"
        payload={{
          ...EMPTY,
          errorMessage: 'Video ist privat oder nicht verfügbar.',
        }}
        onRetry={onRetry}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/import fehlgeschlagen/i)
    expect(alert).toHaveTextContent(/privat oder nicht verfügbar/i)
    await userEvent.click(screen.getByRole('button', { name: /neu starten/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('falls back to a German default message when the error has none', () => {
    render(<PhaseDetailCard phase="error" payload={EMPTY} />)
    expect(screen.getByText(/import fehlgeschlagen/i)).toBeInTheDocument()
    expect(
      screen.getByText(/bitte versuche es später erneut/i),
    ).toBeInTheDocument()
  })
})
