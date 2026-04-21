import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EmptyExtractionExplainer } from './EmptyExtractionExplainer'

const ALL_FALSE_SIGNALS = {
  had_caption_url: false,
  had_blog_source: false,
  had_transcript: false,
} as const

describe('EmptyExtractionExplainer (BUG-034)', () => {
  it('renders the heading, icon and default no_recipe_detected copy', () => {
    render(
      <EmptyExtractionExplainer
        reason="no_recipe_detected"
        sourceUrl={null}
        signals={{
          had_caption_url: false,
          had_blog_source: false,
          had_transcript: true,
        }}
        onProceedEmpty={() => {}}
        onTryAnother={() => {}}
      />,
    )
    expect(
      screen.getByRole('heading', { name: /kein rezept erkannt/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/keine zutaten oder schritte erkannt|manuell ausfüllen/i),
    ).toBeInTheDocument()
  })

  it('falls back to the no_recipe_detected copy when reason is null', () => {
    render(
      <EmptyExtractionExplainer
        reason={null}
        sourceUrl={null}
        signals={ALL_FALSE_SIGNALS}
        onProceedEmpty={() => {}}
        onTryAnother={() => {}}
      />,
    )
    expect(
      screen.getByRole('heading', { name: /kein rezept erkannt/i }),
    ).toBeInTheDocument()
  })

  it('renders empty_transcript copy', () => {
    render(
      <EmptyExtractionExplainer
        reason="empty_transcript"
        sourceUrl={null}
        signals={ALL_FALSE_SIGNALS}
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
        signals={ALL_FALSE_SIGNALS}
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
        signals={ALL_FALSE_SIGNALS}
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
        signals={{
          had_caption_url: false,
          had_blog_source: false,
          had_transcript: true,
        }}
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
        signals={ALL_FALSE_SIGNALS}
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
        signals={ALL_FALSE_SIGNALS}
        onProceedEmpty={() => {}}
        onTryAnother={onTryAnother}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: /anderes video probieren/i }),
    )
    expect(onTryAnother).toHaveBeenCalledTimes(1)
  })

  // BUG-034 (signal-aware) — the explainer tells the user WHICH
  // source signals came up empty so they know whether it's their fault,
  // the video's fault, or the extractor's fault.
  describe('signal-aware copy', () => {
    it('renders no_usable_source copy when all three signals are false', () => {
      render(
        <EmptyExtractionExplainer
          reason="no_usable_source"
          sourceUrl={null}
          signals={ALL_FALSE_SIGNALS}
          onProceedEmpty={() => {}}
          onTryAnother={() => {}}
        />,
      )
      // Copy template (spec):
      // "Wir konnten dieses Video nicht automatisch als Rezept auswerten:
      //  kein Beschreibungstext mit Link, keine Caption und keine Sprachspur
      //  gefunden. Du kannst das Rezept manuell ausfüllen oder ein anderes
      //  Video ausprobieren."
      expect(
        screen.getByText(
          /kein beschreibungstext.*keine caption.*keine sprachspur/i,
        ),
      ).toBeInTheDocument()
    })

    it('renders mixed-signal copy highlighting the transcript when only audio was captured', () => {
      render(
        <EmptyExtractionExplainer
          reason="no_recipe_detected"
          sourceUrl={null}
          signals={{
            had_caption_url: false,
            had_blog_source: false,
            had_transcript: true,
          }}
          onProceedEmpty={() => {}}
          onTryAnother={() => {}}
        />,
      )
      // The mixed copy mentions the signals that WERE present so the
      // user understands "we had audio, the AI just didn't find a
      // recipe in it". German phrasing per the spec.
      expect(
        screen.getByText(/eine audiosprache|sprachspur/i),
      ).toBeInTheDocument()
      expect(screen.getByText(/keine zutaten oder schritte/i)).toBeInTheDocument()
    })

    it('renders mixed-signal copy highlighting both audio and blog when both were captured', () => {
      render(
        <EmptyExtractionExplainer
          reason="no_recipe_detected"
          sourceUrl={null}
          signals={{
            had_caption_url: false,
            had_blog_source: true,
            had_transcript: true,
          }}
          onProceedEmpty={() => {}}
          onTryAnother={() => {}}
        />,
      )
      // Both signals in the signal-list.
      expect(
        screen.getByText(/audiosprache|sprachspur/i),
      ).toBeInTheDocument()
      expect(
        screen.getByText(/blog|webseite/i),
      ).toBeInTheDocument()
    })

    it('renders mixed-signal copy for caption URL only (blog fetch failed)', () => {
      render(
        <EmptyExtractionExplainer
          reason="no_recipe_detected"
          sourceUrl={null}
          signals={{
            had_caption_url: true,
            had_blog_source: false,
            had_transcript: false,
          }}
          onProceedEmpty={() => {}}
          onTryAnother={() => {}}
        />,
      )
      // Spec: the copy should mention the caption-link signal.
      expect(
        screen.getByText(/link|blog-link/i),
      ).toBeInTheDocument()
    })
  })
})
