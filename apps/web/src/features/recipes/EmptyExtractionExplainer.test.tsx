import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EmptyExtractionExplainer } from './EmptyExtractionExplainer'

describe('EmptyExtractionExplainer (BUG-034)', () => {
  it('renders the heading, icon and default no_recipe_detected copy', () => {
    render(
      <EmptyExtractionExplainer
        reason="no_recipe_detected"
        sourceUrl={null}
        onProceedEmpty={() => {}}
        onTryAnother={() => {}}
      />,
    )
    expect(
      screen.getByRole('heading', { name: /kein rezept erkannt/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/kein kochrezept|zutaten und schritte zu erkennen/i),
    ).toBeInTheDocument()
  })

  it('falls back to the no_recipe_detected copy when reason is null', () => {
    render(
      <EmptyExtractionExplainer
        reason={null}
        sourceUrl={null}
        onProceedEmpty={() => {}}
        onTryAnother={() => {}}
      />,
    )
    expect(
      screen.getByText(/kein kochrezept|zutaten und schritte zu erkennen/i),
    ).toBeInTheDocument()
  })

  it('renders empty_transcript copy', () => {
    render(
      <EmptyExtractionExplainer
        reason="empty_transcript"
        sourceUrl={null}
        onProceedEmpty={() => {}}
        onTryAnother={() => {}}
      />,
    )
    expect(
      screen.getByText(/keinen verwertbaren audio-inhalt/i),
    ).toBeInTheDocument()
  })

  it('renders extractor_error copy', () => {
    render(
      <EmptyExtractionExplainer
        reason="extractor_error"
        sourceUrl={null}
        onProceedEmpty={() => {}}
        onTryAnother={() => {}}
      />,
    )
    expect(screen.getByText(/fehler aufgetreten/i)).toBeInTheDocument()
  })

  it('omits the source chip when sourceUrl is null', () => {
    render(
      <EmptyExtractionExplainer
        reason="no_recipe_detected"
        sourceUrl={null}
        onProceedEmpty={() => {}}
        onTryAnother={() => {}}
      />,
    )
    expect(screen.queryByText(/Analysiert:/)).not.toBeInTheDocument()
  })

  it('renders the source chip when a URL is provided', () => {
    render(
      <EmptyExtractionExplainer
        reason="no_recipe_detected"
        sourceUrl="https://example.com/video/123"
        onProceedEmpty={() => {}}
        onTryAnother={() => {}}
      />,
    )
    expect(screen.getByText(/Analysiert:/)).toBeInTheDocument()
    expect(
      screen.getByLabelText(/Analysierte Quelle/i),
    ).toHaveTextContent('https://example.com/video/123')
  })

  it('calls onProceedEmpty when "Trotzdem leer anlegen" is clicked', async () => {
    const onProceedEmpty = vi.fn()
    const user = userEvent.setup()
    render(
      <EmptyExtractionExplainer
        reason="no_recipe_detected"
        sourceUrl={null}
        onProceedEmpty={onProceedEmpty}
        onTryAnother={() => {}}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: /trotzdem leer anlegen/i }),
    )
    expect(onProceedEmpty).toHaveBeenCalledTimes(1)
  })

  it('calls onTryAnother when "Anderes Video probieren" is clicked', async () => {
    const onTryAnother = vi.fn()
    const user = userEvent.setup()
    render(
      <EmptyExtractionExplainer
        reason="no_recipe_detected"
        sourceUrl={null}
        onProceedEmpty={() => {}}
        onTryAnother={onTryAnother}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: /anderes video probieren/i }),
    )
    expect(onTryAnother).toHaveBeenCalledTimes(1)
  })
})
