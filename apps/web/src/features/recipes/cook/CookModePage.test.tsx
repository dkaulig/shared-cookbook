import { describe, expect, it, vi, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { RecipeDetailDto } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { CookModePage } from './CookModePage'

const recipe: RecipeDetailDto = {
  id: 'r1',
  groupId: 'g1',
  createdByUserId: 'u1',
  createdByDisplayName: 'Autor',
  title: 'Spätzle',
  description: 'Mit Käse überbacken',
  defaultServings: 4,
  prepTimeMinutes: 30,
  difficulty: 1,
  sourceUrl: null,
  sourceType: 'Manual',
  forkOfRecipeId: null,
  photos: [],
  lastCookedAt: null,
  createdAt: '2026-04-18T00:00:00Z',
  updatedAt: '2026-04-18T00:00:00Z',
  version: 0,
  ingredients: [
    { id: 'i1', position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
    { id: 'i2', position: 1, quantity: 2, unit: 'Stück', name: 'Eier', note: null, scalable: true },
  ],
  steps: [
    { id: 's1', position: 0, content: 'Mehl in eine Schüssel geben.' },
    { id: 's2', position: 1, content: 'Eier hinzufügen.' },
    { id: 's3', position: 2, content: 'Alles verrühren.' },
  ],
  tags: [],
  nutritionEstimate: null,
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}</div>
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
  server.use(
    http.get('/api/recipes/r1', () => HttpResponse.json(recipe)),
  )
})

function withProviders(path: string): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route
            path="/groups/:groupId/recipes/:recipeId/cook"
            element={<CookModePage />}
          />
          <Route
            path="/groups/:groupId/recipes/:recipeId"
            element={<div>recipe-detail-page</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('CookModePage — initial render', () => {
  it('starts on the portions picker (step -1) defaulted to defaultServings', async () => {
    render(withProviders('/groups/g1/recipes/r1/cook'))
    // Picker heading is present; large numeric readout shows 4.
    expect(
      await screen.findByRole('heading', { name: /Für wie viele Portionen/i }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('cook-portions-picker')).toBeInTheDocument()
    // Top bar portion chip defaults to 4.
    expect(screen.getByRole('button', { name: /Portionen anpassen/i })).toHaveTextContent(
      /4 Portionen/,
    )
  })
})

describe('CookModePage — full happy flow', () => {
  it('picker → mise → step 1..N → finish → mark-cooked → navigate back', async () => {
    const user = userEvent.setup()
    let cookedAt: string | null = null
    server.use(
      http.post('/api/recipes/r1/cook', () => {
        cookedAt = '2026-04-20T12:00:00Z'
        return HttpResponse.json({ ...recipe, lastCookedAt: cookedAt })
      }),
    )

    render(withProviders('/groups/g1/recipes/r1/cook'))

    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })

    // Confirm portions → mise-en-place.
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    expect(screen.getByRole('heading', { name: /Mise en Place/i })).toBeInTheDocument()

    // Start first step.
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByTestId('cook-step-card')
    expect(screen.getByText(/Schritt 1 von 3/i)).toBeInTheDocument()
    // "Mehl" is rendered inside an IngredientChip (COOK-2), the
    // remainder of the sentence is a separate text node — match on
    // the testid + the chip presence.
    expect(screen.getByTestId('cook-step-content')).toHaveTextContent(
      'Mehl in eine Schüssel geben.',
    )

    // → step 2
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    expect(screen.getByText(/Schritt 2 von 3/i)).toBeInTheDocument()
    expect(screen.getByTestId('cook-step-content')).toHaveTextContent(
      'Eier hinzufügen.',
    )

    // → step 3 (last — button label flips to "Fertig")
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    expect(screen.getByText(/Schritt 3 von 3/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Fertig$/i })).toBeInTheDocument()

    // Finish screen
    await user.click(screen.getByRole('button', { name: /^Fertig$/i }))
    await screen.findByTestId('cook-finish-card')
    expect(screen.getByRole('heading', { name: /Geschafft!/i })).toBeInTheDocument()

    // Mark cooked — primary fires mutation, navigates back on success.
    await user.click(screen.getByRole('button', { name: /Jetzt gekocht/i }))
    await waitFor(() => {
      expect(screen.getByTestId('loc')).toHaveTextContent('/groups/g1/recipes/r1')
    })
    expect(screen.getByText('recipe-detail-page')).toBeInTheDocument()
    expect(cookedAt).toBe('2026-04-20T12:00:00Z')
  })
})

describe('CookModePage — back navigation', () => {
  it('back button is disabled on mise-en-place (step 0)', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    expect(screen.getByRole('button', { name: /Zurück/i })).toBeDisabled()
  })

  it('back from step 1 returns to mise-en-place', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByTestId('cook-step-card')
    await user.click(screen.getByRole('button', { name: /Zurück/i }))
    await screen.findByTestId('cook-mise-en-place')
  })
})

describe('CookModePage — portions chip reopens picker', () => {
  it('tapping the portions chip reopens the picker + rescale applies', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    // Advance past the picker first.
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    expect(screen.getByText('500 g')).toBeInTheDocument()

    // Re-open picker via the top-bar chip.
    await user.click(screen.getByRole('button', { name: /Portionen anpassen/i }))
    await screen.findByTestId('cook-portions-picker')

    // Double the portions.
    await user.click(screen.getByRole('button', { name: /Portion erhöhen/i }))
    await user.click(screen.getByRole('button', { name: /Portion erhöhen/i }))
    await user.click(screen.getByRole('button', { name: /Portion erhöhen/i }))
    await user.click(screen.getByRole('button', { name: /Portion erhöhen/i }))
    // 4 → 8 via four plus clicks.

    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    // Mehl rescaled 500 g × (8/4) = 1000 g.
    expect(screen.getByText('1000 g')).toBeInTheDocument()
    // Top-bar chip now reads "8 Portionen".
    expect(
      screen.getByRole('button', { name: /Portionen anpassen — aktuell 8/i }),
    ).toHaveTextContent(/8 Portionen/)
  })
})

describe('CookModePage — wake lock (COOK-1)', () => {
  const originalWakeLock = (navigator as unknown as { wakeLock?: unknown }).wakeLock

  afterEach(() => {
    if (originalWakeLock === undefined) {
      delete (navigator as unknown as { wakeLock?: unknown }).wakeLock
    } else {
      ;(navigator as unknown as { wakeLock?: unknown }).wakeLock = originalWakeLock
    }
  })

  it('requests a screen wake-lock after the portions picker is confirmed', async () => {
    const release = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue({ release })
    ;(navigator as unknown as { wakeLock: unknown }).wakeLock = { request }

    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByTestId('cook-portions-picker')
    // On the picker step (step = -1) the wake-lock should NOT yet be
    // requested — we only turn on the screen-keep-awake when the user
    // actually starts cooking.
    expect(request).not.toHaveBeenCalled()

    // Confirm portions → mise-en-place (step 0) → wake-lock requested.
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('screen')
    })
  })

  it('releases the lock when the cook page unmounts', async () => {
    const release = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue({ release })
    ;(navigator as unknown as { wakeLock: unknown }).wakeLock = { request }

    const user = userEvent.setup()
    const { unmount } = render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByTestId('cook-portions-picker')
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    await waitFor(() => {
      expect(request).toHaveBeenCalled()
    })

    unmount()
    await waitFor(() => {
      expect(release).toHaveBeenCalled()
    })
  })
})

describe('CookModePage — ingredient-chip navigation (COOK-2)', () => {
  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView — stub it globally.
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('tapping an ingredient chip from a step navigates back to mise-en-place with highlight', async () => {
    const recipeWithIngredientInStep: RecipeDetailDto = {
      ...recipe,
      steps: [
        { id: 's1', position: 0, content: 'Vorbereitung.' },
        { id: 's2', position: 1, content: 'Mehl einrühren.' },
        { id: 's3', position: 2, content: 'Fertigstellen.' },
      ],
    }
    server.use(
      http.get('/api/recipes/r1', () =>
        HttpResponse.json(recipeWithIngredientInStep),
      ),
    )

    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))

    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    // Advance past picker → mise
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    // → step 1
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByTestId('cook-step-card')
    // → step 2 (the one with "Mehl")
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByText(/Schritt 2 von 3/i)

    // Tap the ingredient chip for "Mehl" — expected: navigate back to
    // mise-en-place with the row highlighted.
    const chip = await screen.findByTestId('ingredient-chip')
    await user.click(chip)

    await screen.findByTestId('cook-mise-en-place')
    // The highlighted ingredient row gets the ring class.
    const rows = screen.getAllByRole('checkbox')
    const mehlRow = rows.find((r) => r.textContent?.includes('Mehl'))!
    expect(mehlRow.className).toMatch(/ring-2/)
  })
})

describe('CookModePage — exit confirmation', () => {
  it('X-close opens the confirm dialog', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByTestId('cook-portions-picker')
    await user.click(screen.getByRole('button', { name: /Kochmodus schliessen/i }))
    expect(
      await screen.findByRole('heading', { name: /Kochmodus wirklich beenden/i }),
    ).toBeInTheDocument()
  })

  it('cancel keeps the user in cook mode', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByTestId('cook-portions-picker')
    await user.click(screen.getByRole('button', { name: /Kochmodus schliessen/i }))
    await screen.findByRole('heading', { name: /Kochmodus wirklich beenden/i })

    // Cancel via the "Abbrechen" button inside the confirm dialog.
    const dialog = screen.getByTestId('confirm-dialog')
    await user.click(
      Array.from(dialog.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Abbrechen',
      )!,
    )
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
    // Still on the cook stage — path unchanged.
    expect(screen.getByTestId('loc')).toHaveTextContent('/groups/g1/recipes/r1/cook')
    expect(screen.getByTestId('cook-portions-picker')).toBeInTheDocument()
  })

  it('confirm navigates back to the recipe detail page', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByTestId('cook-portions-picker')
    await user.click(screen.getByRole('button', { name: /Kochmodus schliessen/i }))
    await screen.findByRole('heading', { name: /Kochmodus wirklich beenden/i })

    const dialog = screen.getByTestId('confirm-dialog')
    const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'Beenden',
    )!
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(screen.getByTestId('loc')).toHaveTextContent('/groups/g1/recipes/r1')
    })
    expect(screen.getByText('recipe-detail-page')).toBeInTheDocument()
  })
})

describe('CookModePage — keyboard navigation (→ / ← / Space)', () => {
  it('ArrowRight from mise-en-place advances to step 1', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')

    await user.keyboard('{ArrowRight}')

    await screen.findByTestId('cook-step-card')
    expect(screen.getByText(/Schritt 1 von 3/i)).toBeInTheDocument()
  })

  it('Space advances the step the same as ArrowRight', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')

    await user.keyboard(' ')

    await screen.findByTestId('cook-step-card')
    expect(screen.getByText(/Schritt 1 von 3/i)).toBeInTheDocument()
  })

  it('ArrowLeft from step 2 returns to step 1', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByText(/Schritt 1 von 3/i)
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByText(/Schritt 2 von 3/i)

    await user.keyboard('{ArrowLeft}')

    expect(screen.getByText(/Schritt 1 von 3/i)).toBeInTheDocument()
  })

  it('ArrowRight at the last step advances to the finish card', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByText(/Schritt 1 von 3/i)
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByText(/Schritt 2 von 3/i)
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByText(/Schritt 3 von 3/i)

    await user.keyboard('{ArrowRight}')

    await screen.findByTestId('cook-finish-card')
  })

  it('ArrowLeft at step 1 does NOT navigate back to the portions picker', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByText(/Schritt 1 von 3/i)

    await user.keyboard('{ArrowLeft}')

    // ArrowLeft from step 1 lands on mise-en-place (step 0), NOT the picker (-1).
    await screen.findByTestId('cook-mise-en-place')
    expect(screen.queryByTestId('cook-portions-picker')).not.toBeInTheDocument()

    // Another ArrowLeft on mise-en-place is a no-op (no picker reopen).
    await user.keyboard('{ArrowLeft}')
    expect(screen.queryByTestId('cook-portions-picker')).not.toBeInTheDocument()
    expect(screen.getByTestId('cook-mise-en-place')).toBeInTheDocument()
  })

  it('ArrowRight on the finish card is a no-op (bottom bar hidden)', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await user.click(screen.getByRole('button', { name: /^Fertig$/i }))
    await screen.findByTestId('cook-finish-card')

    await user.keyboard('{ArrowRight}')

    // Still on the finish card — no further progression.
    expect(screen.getByTestId('cook-finish-card')).toBeInTheDocument()
  })

  it('keyboard is inactive while the portions picker is open (step -1)', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByTestId('cook-portions-picker')

    await user.keyboard('{ArrowRight}')

    // Still on the picker — ArrowRight did NOT advance past it.
    expect(screen.getByTestId('cook-portions-picker')).toBeInTheDocument()
    expect(screen.queryByTestId('cook-mise-en-place')).not.toBeInTheDocument()
  })

  it('keyboard is inactive while a form input has focus', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')

    // Mount a focused input so document.activeElement is an <input>.
    const input = document.createElement('input')
    input.setAttribute('data-testid', 'scratch-input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)

    await user.keyboard('{ArrowRight}')

    // No navigation — we are still on mise-en-place.
    expect(screen.getByTestId('cook-mise-en-place')).toBeInTheDocument()
    expect(screen.queryByTestId('cook-step-card')).not.toBeInTheDocument()

    input.remove()
  })
})

// TABLET-4 — on tablet landscape (>= 768 px AND orientation: landscape)
// the Cook-Now stage renders BOTH the mise-en-place ingredients list
// AND the current step pane at the same time, so the cook never has
// to tab-switch to see the ingredients mid-step. Portrait / mobile
// stays the single-pane tab layout from v0.9.0.
describe('CookModePage — tablet landscape two-pane layout (TABLET-4)', () => {
  const originalMatchMedia = window.matchMedia

  /**
   * Mock `window.matchMedia` so any query that contains BOTH
   * `min-width: 768px` AND `orientation: landscape` reports `true`.
   * Every other query (including the plain `(max-width: 767px)` the
   * `useIsMobile` hook uses) falls back to `false`. jsdom doesn't
   * track a real viewport, so this is the cleanest way to force the
   * landscape branch without touching the component's CSS layer.
   */
  function mockLandscape(active: boolean) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches:
          active &&
          query.includes('min-width: 768px') &&
          query.includes('landscape'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      }),
    })
  }

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    })
  })

  it('renders BOTH the mise-en-place list AND the current step card on tablet landscape while on step 1', async () => {
    mockLandscape(true)
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))

    // Past the picker → mise (step 0) → step 1.
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    await user.click(screen.getByRole('button', { name: /Weiter/i }))

    // Both panes are simultaneously present — the step is on the right,
    // the ingredients list on the left.
    await screen.findByTestId('cook-step-card')
    expect(screen.getByTestId('cook-mise-en-place')).toBeInTheDocument()
    expect(screen.getByText(/Schritt 1 von 3/i)).toBeInTheDocument()
  })

  it('step nav on tablet landscape updates only the right pane — left pane stays visible', async () => {
    mockLandscape(true)
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))

    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByText(/Schritt 1 von 3/i)

    // Advance to step 2 → right pane flips, left pane still there.
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    expect(screen.getByText(/Schritt 2 von 3/i)).toBeInTheDocument()
    expect(screen.getByTestId('cook-mise-en-place')).toBeInTheDocument()
  })

  it('still renders the mise-en-place tab single-pane on portrait (no matchMedia match)', async () => {
    // Default jsdom matchMedia returns false for every query → portrait.
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))

    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    // Advance to step 1 — in portrait, the mise-en-place must NOT remain mounted.
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByTestId('cook-step-card')
    expect(screen.queryByTestId('cook-mise-en-place')).not.toBeInTheDocument()
  })

  it('on the finish screen the mise-en-place pane is hidden even in landscape', async () => {
    mockLandscape(true)
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))

    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    // Click through all 3 steps → Fertig button → finish card.
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await user.click(screen.getByRole('button', { name: /^Fertig$/i }))
    await screen.findByTestId('cook-finish-card')

    // Left pane collapses on the finish screen so the celebration is full-width.
    expect(screen.queryByTestId('cook-mise-en-place')).not.toBeInTheDocument()
  })
})
