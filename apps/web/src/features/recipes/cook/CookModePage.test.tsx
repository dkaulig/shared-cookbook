import { describe, expect, it, vi, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type {
  RecipeDetailDto,
  RecipeTranslationResponse,
} from '@familien-kochbuch/shared'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '@/i18n'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { recipeQueryKeys } from '../queryKeys'
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
  // COMP-2 — single-default component nests the pre-COMP-2 fixture's
  // flat ingredient+step arrays so the cook page renders identically.
  components: [
    {
      id: 'c1',
      position: 0,
      label: null,
      ingredients: [
        { id: 'i1', position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
        { id: 'i2', position: 1, quantity: 2, unit: 'Stück', name: 'Eier', note: null, scalable: true },
      ],
      steps: [
        { id: 's1', position: 0, content: 'Mehl in eine Schüssel geben.' },
        { id: 's2', position: 1, content: 'Eier hinzufügen.' },
        { id: 's3', position: 2, content: 'Alles verrühren.' },
      ],
    },
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

function withProviders(
  path: string,
  options: {
    client?: QueryClient
    i18n?: import('i18next').i18n
  } = {},
): ReactNode {
  const client =
    options.client ??
    new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (
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
  // LANG-2-FU-1 — specs that pin the UI language wrap with a detached
  // i18n instance so they don't mutate the global singleton (which
  // would leak into parallel test files via the shared default).
  return options.i18n ? (
    <I18nextProvider i18n={options.i18n}>{tree}</I18nextProvider>
  ) : (
    tree
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
    // COMP-2 — keep the single-default component but swap out its
    // steps to the "Mehl einrühren" one so the chip surfaces on step 2.
    const recipeWithIngredientInStep: RecipeDetailDto = {
      ...recipe,
      components: [
        {
          ...recipe.components[0]!,
          steps: [
            { id: 's1', position: 0, content: 'Vorbereitung.' },
            { id: 's2', position: 1, content: 'Mehl einrühren.' },
            { id: 's3', position: 2, content: 'Fertigstellen.' },
          ],
        },
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

// ── COMP-2 — component grouping in Cook-Now ─────────────────────────

describe('CookModePage — COMP-2 component grouping', () => {
  const multiComponentRecipe: RecipeDetailDto = {
    ...recipe,
    components: [
      {
        id: 'c-sauce',
        position: 0,
        label: 'Chipotle Sauce',
        ingredients: [
          { id: 'i-s1', position: 0, quantity: 2, unit: 'EL', name: 'Honig', note: null, scalable: true },
          { id: 'i-s2', position: 1, quantity: 1, unit: 'TL', name: 'Chipotle', note: null, scalable: true },
        ],
        steps: [
          { id: 'st-s1', position: 0, content: 'Sauce mischen.' },
        ],
      },
      {
        id: 'c-main',
        position: 1,
        label: null,
        ingredients: [
          { id: 'i-m1', position: 0, quantity: 2, unit: 'Stück', name: 'Tortilla', note: null, scalable: true },
        ],
        steps: [
          { id: 'st-m1', position: 0, content: 'Tortilla anbraten.' },
          { id: 'st-m2', position: 1, content: 'Sauce dazugeben.' },
        ],
      },
    ],
  }

  it('mise-en-place pane groups ingredients by component with sub-headers (Chipotle Sauce + Hauptgericht)', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/recipes/r1', () =>
        HttpResponse.json(multiComponentRecipe),
      ),
    )
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')

    // Two group containers surface in the DOM.
    const groups = screen.getAllByTestId('cook-mise-en-place-group')
    expect(groups.length).toBe(2)
    // Sub-headers carry the component label and the German fallback.
    const subheaders = screen.getAllByTestId('cook-mise-en-place-subheader')
    const labels = subheaders.map((h) => h.textContent)
    expect(labels).toContain('Chipotle Sauce')
    expect(labels).toContain('Hauptgericht')
  })

  it('mise-en-place pane suppresses sub-headers on a single-default recipe', async () => {
    // Default-recipe fixture has label:null + one component → no
    // sub-header chrome.
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    expect(
      screen.queryAllByTestId('cook-mise-en-place-subheader'),
    ).toHaveLength(0)
  })

  it('step pane shows a component chip above the current step when the recipe is multi-component', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/recipes/r1', () =>
        HttpResponse.json(multiComponentRecipe),
      ),
    )
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')

    // Advance to step 1 — which belongs to the Chipotle Sauce component.
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByTestId('cook-step-card')
    const chip = screen.getByTestId('cook-step-component-chip')
    expect(chip).toHaveTextContent(/Chipotle Sauce/i)

    // Advance to step 2 — still Chipotle Sauce? No — recipe has 1 step
    // in sauce, so step 2 jumps to main (null label → Hauptgericht).
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    expect(screen.getByTestId('cook-step-component-chip')).toHaveTextContent(
      /Hauptgericht/i,
    )
  })

  it('step pane suppresses the component chip on a single-default recipe', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook'))
    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByTestId('cook-step-card')
    expect(
      screen.queryByTestId('cook-step-component-chip'),
    ).not.toBeInTheDocument()
  })
})

// ── LANG-2-FU-1 — Cook-Now honors the active translation ─────────────
//
// Audit-finding from LANG-2-Verification: the Cook-Now mode used to
// fetch its own RecipeDetailDto via `useRecipe(recipeId)` and ignored
// any per-recipe translation the user had toggled on the detail page.
// Result: user toggles "Auf Englisch anzeigen" → clicks Jetzt kochen
// → suddenly stares at the German original. Per LANG-2 design-doc Q5-B
// "view-respecting", Cook-Now should match the active display.
//
// Strategy (Option B, design-doc): read the `useCachedTranslation`
// entry for `(recipeId, i18n.language)` and, if the recipe's
// sourceLanguage differs from the active UI language AND a cached
// translation exists, merge it via `applyTranslation` before
// rendering. Deep-link friendly because the cache lookup defaults on
// the current UI lang — no Route-State coupling required.
describe('CookModePage — LANG-2-FU-1 view-respecting translation', () => {
  // The CookModePage test fixtures pre-date LANG-2, so add the
  // sourceLanguage ('de') explicitly so the (sourceLanguage !== uiLang)
  // gate fires for an EN-pinned UI.
  const germanRecipe: RecipeDetailDto = {
    ...recipe,
    sourceLanguage: 'de',
  }

  const englishTranslationPayload = {
    title: 'Spaetzle',
    description: 'Cheese-baked Swabian noodles.',
    components: [
      {
        id: 'c1',
        position: 0,
        label: null,
        ingredients: [
          { position: 0, name: 'Flour', unit: 'g', note: null },
          { position: 1, name: 'Eggs', unit: 'pcs', note: null },
        ],
        steps: [
          { position: 0, content: 'Place flour in a bowl.' },
          { position: 1, content: 'Add the eggs.' },
          { position: 2, content: 'Mix everything together.' },
        ],
      },
    ],
    tags: [],
  }

  function buildCachedTranslationResponse(
    overrides: Partial<RecipeTranslationResponse> = {},
  ): RecipeTranslationResponse {
    return {
      recipeId: 'r1',
      language: 'en',
      translatedPayload: JSON.stringify(englishTranslationPayload),
      isStale: false,
      cacheHit: true,
      updatedAt: '2026-04-22T00:00:00Z',
      ...overrides,
    }
  }

  beforeEach(() => {
    server.use(
      http.get('/api/recipes/r1', () => HttpResponse.json(germanRecipe)),
    )
  })

  it('renders the cached EN translation when UI lang is EN and a translation is cached', async () => {
    const i18n = await createI18n({ initialLng: 'en' })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(
      recipeQueryKeys.translation('r1', 'en'),
      buildCachedTranslationResponse(),
    )

    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook', { client, i18n }))

    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')

    // Translated ingredient names render on the mise-en-place pane.
    expect(screen.getByText('Flour')).toBeInTheDocument()
    expect(screen.getByText('Eggs')).toBeInTheDocument()
    // Original DE names must NOT leak through.
    expect(screen.queryByText('Mehl')).not.toBeInTheDocument()
    expect(screen.queryByText('Eier')).not.toBeInTheDocument()

    // Translated step content surfaces on step 1.
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    await screen.findByTestId('cook-step-card')
    expect(screen.getByTestId('cook-step-content')).toHaveTextContent(
      'Place flour in a bowl.',
    )
  })

  it('falls back to the original DE recipe when no translation is cached for the active UI lang', async () => {
    // No translation seeded — Cook-Now must render the original recipe
    // verbatim (no fallback-loading-loop, no broken UI).
    const i18n = await createI18n({ initialLng: 'en' })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook', { client, i18n }))

    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')

    // Original DE names render — there's nothing to translate against.
    expect(screen.getByText('Mehl')).toBeInTheDocument()
    expect(screen.getByText('Eier')).toBeInTheDocument()
  })

  it('keeps the original recipe when sourceLanguage matches the active UI lang (no cache lookup)', async () => {
    // UI lang is DE, recipe sourceLanguage is DE — Cook-Now must NOT
    // consult the translation cache at all and renders the original
    // even if a stale EN entry happens to be cached.
    const i18n = await createI18n({ initialLng: 'de' })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(
      recipeQueryKeys.translation('r1', 'en'),
      buildCachedTranslationResponse(),
    )

    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook', { client, i18n }))

    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')

    expect(screen.getByText('Mehl')).toBeInTheDocument()
    expect(screen.queryByText('Flour')).not.toBeInTheDocument()
  })

  it('surfaces a stale-translation hint when the cached translation is flagged stale', async () => {
    const i18n = await createI18n({ initialLng: 'en' })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(
      recipeQueryKeys.translation('r1', 'en'),
      buildCachedTranslationResponse({ isStale: true }),
    )

    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1/cook', { client, i18n }))

    await screen.findByRole('heading', { name: /Für wie viele Portionen/i })
    await user.click(screen.getByRole('button', { name: /^Weiter$/i }))
    await screen.findByTestId('cook-mise-en-place')

    // A small inline hint informs the cook the translation may be
    // outdated (no refresh-action — the design-doc keeps the refresh
    // CTA on the detail page).
    expect(screen.getByTestId('cook-translation-stale-hint')).toBeInTheDocument()
  })
})
