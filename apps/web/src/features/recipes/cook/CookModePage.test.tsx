import { describe, expect, it } from 'vitest'
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
    expect(screen.getByText('Mehl in eine Schüssel geben.')).toBeInTheDocument()

    // → step 2
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    expect(screen.getByText(/Schritt 2 von 3/i)).toBeInTheDocument()
    expect(screen.getByText('Eier hinzufügen.')).toBeInTheDocument()

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
