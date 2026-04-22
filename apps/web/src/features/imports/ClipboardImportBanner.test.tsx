import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { ClipboardImportBanner } from './ClipboardImportBanner'

/**
 * CLIP-0 — clipboard-import banner tests.
 *
 * The banner is the iOS PWA fallback for the W3C Web Share Target API.
 * iOS Safari requires a user gesture to read the clipboard, so the
 * banner renders a "Prüfen"-button; only the tap triggers
 * `navigator.clipboard.readText()`.
 */
function LocationProbe() {
  const loc = useLocation()
  return (
    <div
      data-testid="location"
      data-pathname={loc.pathname}
      data-search={loc.search}
    />
  )
}

function renderBanner() {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={['/']}>
        <LocationProbe />
        <Routes>
          <Route path="/" element={children} />
          <Route
            path="/rezepte/import/url"
            element={<div data-testid="import-url-page">import-url</div>}
          />
        </Routes>
      </MemoryRouter>
    )
  }
  return render(<ClipboardImportBanner />, { wrapper: Wrapper })
}

type ClipboardStub = { readText: ReturnType<typeof vi.fn> }

function installClipboard(readText: ReturnType<typeof vi.fn>): void {
  // NOTE: user-event's `setup()` attaches its own clipboard stub to
  // the JSDOM window (see `attachClipboardStubToView`). Always install
  // OUR mock AFTER `userEvent.setup()` or user-event's stub silently
  // replaces it and `readText()` returns "".
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText } satisfies ClipboardStub,
  })
}

function uninstallClipboard(): void {
  // Restore to an object WITHOUT readText so "unsupported" tests read
  // the same shape the browser would expose on an older engine.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  })
}

describe('<ClipboardImportBanner />', () => {
  const originalClipboard = (navigator as unknown as { clipboard?: unknown })
    .clipboard

  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    sessionStorage.clear()
    if (originalClipboard === undefined) {
      uninstallClipboard()
    } else {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      })
    }
    vi.restoreAllMocks()
  })

  it('renders the banner when the clipboard API is available', () => {
    installClipboard(vi.fn().mockResolvedValue(''))
    renderBanner()
    expect(
      screen.getByText(/Link aus Zwischenablage importieren\?/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Prüfen/i })).toBeInTheDocument()
  })

  it('does not render the banner when the clipboard API is unavailable', () => {
    uninstallClipboard()
    renderBanner()
    expect(
      screen.queryByText(/Link aus Zwischenablage importieren\?/i),
    ).not.toBeInTheDocument()
  })

  it('navigates to /rezepte/import/url with the URL on Prüfen when clipboard holds a URL', async () => {
    const user = userEvent.setup()
    installClipboard(vi.fn().mockResolvedValue('https://fb.com/x'))
    renderBanner()

    await user.click(screen.getByRole('button', { name: /Prüfen/i }))

    await waitFor(() => {
      expect(screen.getByTestId('import-url-page')).toBeInTheDocument()
    })
    const loc = screen.getByTestId('location')
    expect(loc.getAttribute('data-pathname')).toBe('/rezepte/import/url')
    expect(loc.getAttribute('data-search')).toBe(
      '?url=https%3A%2F%2Ffb.com%2Fx',
    )
  })

  it('shows the no-URL error when clipboard text does not parse as http(s)', async () => {
    const user = userEvent.setup()
    installClipboard(vi.fn().mockResolvedValue('just some plain text, no link'))
    renderBanner()

    await user.click(screen.getByRole('button', { name: /Prüfen/i }))

    expect(
      await screen.findByText(/Kein Link in der Zwischenablage gefunden/i),
    ).toBeInTheDocument()
  })

  it('rejects a hostile javascript: scheme as no-URL', async () => {
    // Security: extractSharedUrl blocks non-http(s). The banner must
    // treat a javascript: payload exactly like non-URL text — no
    // navigation, no inline render of the hostile string.
    const user = userEvent.setup()
    installClipboard(
      vi.fn().mockResolvedValue('javascript:alert(document.cookie)'),
    )
    renderBanner()

    await user.click(screen.getByRole('button', { name: /Prüfen/i }))

    expect(
      await screen.findByText(/Kein Link in der Zwischenablage gefunden/i),
    ).toBeInTheDocument()
    expect(screen.getByTestId('location').getAttribute('data-pathname')).toBe(
      '/',
    )
  })

  it('shows the permission-error + manual-import link when readText rejects', async () => {
    const user = userEvent.setup()
    installClipboard(
      vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')),
    )
    renderBanner()

    await user.click(screen.getByRole('button', { name: /Prüfen/i }))

    expect(
      await screen.findByText(/Zwischenablage nicht verfügbar/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /manuell/i }),
    ).toHaveAttribute('href', '/rezepte/import/url')
  })

  it('dismiss button hides the banner', async () => {
    const user = userEvent.setup()
    installClipboard(vi.fn().mockResolvedValue(''))
    renderBanner()

    await user.click(
      screen.getByRole('button', { name: /Banner schließen/i }),
    )

    expect(
      screen.queryByText(/Link aus Zwischenablage importieren\?/i),
    ).not.toBeInTheDocument()
  })

  it('re-arms the banner on re-mount after a URL was consumed (different URL ready to import)', async () => {
    const user = userEvent.setup()
    installClipboard(vi.fn().mockResolvedValue('https://fb.com/x'))
    const { unmount } = renderBanner()

    // First mount: Prüfen → navigate.
    await user.click(screen.getByRole('button', { name: /Prüfen/i }))
    await waitFor(() => {
      expect(screen.getByTestId('import-url-page')).toBeInTheDocument()
    })

    unmount()

    // Second mount (user navigated back to an app-wide route with a
    // different URL in clipboard): banner appears again. A sessionStorage-
    // based suppression tied to the first URL would swallow the new one,
    // defeating the "import multiple reels in a row" flow — keep it
    // unsuppressed so the user sees the prompt for every switch-back.
    renderBanner()
    expect(
      screen.getByText(/Link aus Zwischenablage importieren\?/i),
    ).toBeInTheDocument()
  })

  it('re-arms the banner on visibilitychange → visible after user dismissed it', async () => {
    const user = userEvent.setup()
    installClipboard(vi.fn().mockResolvedValue(''))
    renderBanner()

    await user.click(
      screen.getByRole('button', { name: /Banner schließen/i }),
    )
    expect(
      screen.queryByText(/Link aus Zwischenablage importieren\?/i),
    ).not.toBeInTheDocument()

    // Simulate iOS user switching back to the PWA.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))

    await waitFor(() => {
      expect(
        screen.getByText(/Link aus Zwischenablage importieren\?/i),
      ).toBeInTheDocument()
    })
  })
})
