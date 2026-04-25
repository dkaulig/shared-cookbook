import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TranslationBanner } from './TranslationBanner'

describe('<TranslationBanner />', () => {
  it('renders the German source-language copy by default', () => {
    render(
      <TranslationBanner
        sourceLanguage="de"
        isStale={false}
        onShowOriginal={() => {}}
      />,
    )
    expect(
      screen.getByText(/Automatisch aus dem Deutschen übersetzt/i),
    ).toBeInTheDocument()
  })

  it('renders the English source-language copy when sourceLanguage="en"', () => {
    render(
      <TranslationBanner
        sourceLanguage="en"
        isStale={false}
        onShowOriginal={() => {}}
      />,
    )
    expect(
      screen.getByText(/Automatisch aus dem Englischen übersetzt/i),
    ).toBeInTheDocument()
  })

  it('hides the stale hint when isStale is false', () => {
    render(
      <TranslationBanner
        sourceLanguage="de"
        isStale={false}
        onShowOriginal={() => {}}
      />,
    )
    expect(screen.queryByText(/veraltet/i)).not.toBeInTheDocument()
  })

  it('shows the stale hint and refresh CTA when isStale is true', () => {
    render(
      <TranslationBanner
        sourceLanguage="de"
        isStale={true}
        onShowOriginal={() => {}}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByText(/veraltet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Aktualisieren/i })).toBeInTheDocument()
  })

  it('fires onShowOriginal when the user clicks "Original anzeigen"', async () => {
    const onShowOriginal = vi.fn()
    render(
      <TranslationBanner
        sourceLanguage="de"
        isStale={false}
        onShowOriginal={onShowOriginal}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /Original anzeigen/i }))
    expect(onShowOriginal).toHaveBeenCalledTimes(1)
  })

  it('fires onRefresh on stale-banner CTA click', async () => {
    const onRefresh = vi.fn()
    render(
      <TranslationBanner
        sourceLanguage="de"
        isStale={true}
        onShowOriginal={() => {}}
        onRefresh={onRefresh}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /Aktualisieren/i }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('disables the refresh button while a refresh is pending', () => {
    render(
      <TranslationBanner
        sourceLanguage="de"
        isStale={true}
        onShowOriginal={() => {}}
        onRefresh={() => {}}
        refreshPending
      />,
    )
    const button = screen.getByRole('button', { name: /Übersetze/i })
    expect(button).toBeDisabled()
  })

  it('omits the refresh button when no onRefresh handler is provided (stale = true)', () => {
    render(
      <TranslationBanner
        sourceLanguage="de"
        isStale={true}
        onShowOriginal={() => {}}
      />,
    )
    // The stale-hint copy is still rendered…
    expect(screen.getByText(/veraltet/i)).toBeInTheDocument()
    // …but no Aktualisieren button appears (button list contains only
    // the "Original anzeigen" affordance).
    expect(screen.queryByRole('button', { name: /Aktualisieren/i })).not.toBeInTheDocument()
  })
})
