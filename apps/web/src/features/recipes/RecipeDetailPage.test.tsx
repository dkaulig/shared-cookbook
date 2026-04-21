import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { RecipeDetailDto } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { RecipeDetailPage } from './RecipeDetailPage'
import { BottomZoneProvider } from '@/components/layout/bottomZone'
import { BottomNav } from '@/components/layout/BottomNav'

const recipe: RecipeDetailDto = {
  id: 'r1',
  groupId: 'g1',
  createdByUserId: 'u1',
  createdByDisplayName: 'Autor Alice',
  title: 'Spätzle',
  description: 'Mit Käse überbacken',
  defaultServings: 4,
  prepTimeMinutes: 30,
  difficulty: 1,
  sourceUrl: 'https://example.com/recipe',
  sourceType: 'Manual',
  forkOfRecipeId: null,
  photos: ['fake://a.jpg'],
  lastCookedAt: null,
  createdAt: '2026-04-18T00:00:00Z',
  updatedAt: '2026-04-18T00:00:00Z',
  version: 0,
  ingredients: [
    { id: 'i1', position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
    { id: 'i2', position: 1, quantity: null, unit: 'Prise', name: 'Salz', note: null, scalable: false },
  ],
  steps: [
    { id: 's1', position: 0, content: 'Mehl in eine Schüssel geben.' },
    { id: 's2', position: 1, content: 'Eier und Salz hinzufügen.' },
  ],
  tags: [{ id: 't1', name: 'deftig', category: 'Typ', isGlobal: true, groupId: null }],
  nutritionEstimate: null,
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
  server.use(
    http.get('/api/recipes/r1', () => HttpResponse.json(recipe)),
    http.get('/api/groups/g1', () =>
      HttpResponse.json({
        id: 'g1',
        name: 'Familie',
        description: null,
        coverImageUrl: null,
        defaultServings: 2,
        isPrivateCollection: false,
        memberCount: 1,
        myRole: 'Admin',
        version: 0,
        members: [],
      }),
    ),
    // S6: the history panel fires a revisions request on mount; default
    // to an empty list so the rest of the detail-page assertions stay
    // focused on the slices they own.
    http.get('/api/recipes/r1/revisions', () => HttpResponse.json([])),
  )
})

function withProviders(path: string): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // BUG-036 — the "Jetzt gekocht" / "In Wochenplan" action bar moved
  // into the unified Bottom-Zone slot, so tests must render
  // <BottomZoneProvider> + <BottomNav> for the slot JSX to materialise.
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <BottomZoneProvider>
          <Routes>
            <Route path="/groups/:groupId/recipes/:recipeId" element={<RecipeDetailPage />} />
          </Routes>
          <BottomNav />
        </BottomZoneProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('RecipeDetailPage', () => {
  it('shows skeleton placeholders while the recipe is loading', async () => {
    let resolveRecipe: ((value: RecipeDetailDto) => void) | undefined
    server.use(
      http.get('/api/recipes/r1', () => new Promise<Response>((resolve) => {
        resolveRecipe = (body) => resolve(HttpResponse.json(body))
      })),
    )
    render(withProviders('/groups/g1/recipes/r1'))

    const skeletons = await screen.findAllByRole('status')
    expect(skeletons.length).toBeGreaterThan(3)

    resolveRecipe?.(recipe)
    expect(await screen.findByRole('heading', { name: /Spätzle/ })).toBeInTheDocument()
  })

  it('renders title, description, ingredients, steps and tags', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    expect(await screen.findByRole('heading', { name: /Spätzle/ })).toBeInTheDocument()
    expect(screen.getByText('Mit Käse überbacken')).toBeInTheDocument()
    // Ingredient name rendered inside ingredient list — assert exact text.
    expect(screen.getByText('Salz')).toBeInTheDocument()
    expect(screen.getAllByText(/Mehl/)).not.toHaveLength(0)
    expect(screen.getByText('Mehl in eine Schüssel geben.')).toBeInTheDocument()
    expect(screen.getByText('deftig')).toBeInTheDocument()
  })

  it('renders a link to the source URL when present', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    const link = await screen.findByRole('link', { name: /Zur Original-Quelle/i })
    expect(link).toHaveAttribute('href', 'https://example.com/recipe')
  })

  it('renders the portion stepper seeded at defaultServings', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    // DS5: the stepper is a pill with the numeric value rendered as
    // text (not an <input>), alongside a 'Personen' sub-caption.
    await screen.findByRole('heading', { name: /Spätzle/ })
    const stepper = screen.getByRole('group', { name: /Portionen-Stepper/i })
    expect(stepper).toHaveTextContent(/^[−-]?4/)
    expect(stepper).toHaveTextContent(/Personen/i)
  })

  it('renders scaled ingredient list matching default servings at initial render', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    expect(await screen.findByText('500 g')).toBeInTheDocument()
    expect(screen.getByText('nach Geschmack')).toBeInTheDocument()
  })

  it('renders the group-default umrechnen button using the fetched group settings', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    expect(
      await screen.findByRole('button', { name: /Für Familie umrechnen \(2 Portionen\)/i }),
    ).toBeInTheDocument()
  })

  it('renders a fork banner with a link to the original when forkOfRecipeId is set', async () => {
    server.use(
      http.get('/api/recipes/r1', () =>
        HttpResponse.json({ ...recipe, forkOfRecipeId: 'r-original' }),
      ),
    )
    render(withProviders('/groups/g1/recipes/r1'))
    // DS5 copy lives inside RecipeForkBanner: 'Geforkt aus „{Titel}"'.
    expect(await screen.findByText(/Geforkt aus/i)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /Spätzle/i })
    expect(link.getAttribute('href')).toMatch(/\/recipes\/r-original$/)
  })

  it('does not render a fork banner when forkOfRecipeId is null', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })
    expect(screen.queryByText(/Geforkt aus/i)).not.toBeInTheDocument()
  })

  it('opens the fork dialog from the overflow menu "In andere Gruppe kopieren" item', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json([
          {
            id: 'g1',
            name: 'Familie',
            description: null,
            coverImageUrl: null,
            defaultServings: 2,
            isPrivateCollection: true,
            memberCount: 1,
            myRole: 'Admin',
            version: 0,
          },
          {
            id: 'g2',
            name: 'Sonstige',
            description: null,
            coverImageUrl: null,
            defaultServings: 4,
            isPrivateCollection: false,
            memberCount: 2,
            myRole: 'Member',
            version: 0,
          },
        ]),
      ),
    )
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })
    // DS5 moved fork/edit/delete into the top-bar overflow menu.
    await user.click(screen.getByRole('button', { name: /Mehr/i }))
    await user.click(
      await screen.findByRole('menuitem', { name: /In andere Gruppe kopieren/i }),
    )
    expect(
      await screen.findByRole('heading', { name: /In andere Gruppe kopieren/i, level: 2 }),
    ).toBeInTheDocument()
  })

  // ── P2-10 — Nutrition section ─────────────────────────────────────

  it('does not render the Nährwerte section when nutritionEstimate is null for a non-author', async () => {
    useAuthStore.setState({
      accessToken: 't',
      // A different user id → not the author of r1 (createdByUserId=u1).
      user: { id: 'u-other', email: 'other@ex.com', displayName: 'O', role: 'User' },
    })
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })
    expect(screen.queryByRole('heading', { name: /Nährwerte/i })).not.toBeInTheDocument()
  })

  it('renders the Nährwerte section with a "geschätzt" badge when values are present', async () => {
    server.use(
      http.get('/api/recipes/r1', () =>
        HttpResponse.json({
          ...recipe,
          nutritionEstimate: {
            kcal: 420,
            proteinG: 24,
            carbsG: 38,
            fatG: 9,
          },
        }),
      ),
    )
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })
    const heading = screen.getByRole('heading', { name: /Nährwerte/i })
    expect(heading).toBeInTheDocument()
    expect(heading).toHaveTextContent(/geschätzt/i)
    // Four rows rendered with unit suffixes.
    expect(screen.getByText(/^420 kcal$/)).toBeInTheDocument()
    expect(screen.getByText(/^24 g$/)).toBeInTheDocument()
    expect(screen.getByText(/^38 g$/)).toBeInTheDocument()
    expect(screen.getByText(/^9 g$/)).toBeInTheDocument()
  })

  it('inline-edits a nutrition value and PATCHes the recipe', async () => {
    const user = userEvent.setup()
    let patched: unknown = null
    server.use(
      http.get('/api/recipes/r1', () =>
        HttpResponse.json({
          ...recipe,
          nutritionEstimate: {
            kcal: 420,
            proteinG: 24,
            carbsG: 38,
            fatG: 9,
          },
        }),
      ),
      http.patch('/api/recipes/r1/nutrition', async ({ request }) => {
        patched = await request.json()
        return HttpResponse.json({
          ...recipe,
          nutritionEstimate: patched,
        })
      }),
    )
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Nährwerte/i })

    await user.click(screen.getByRole('button', { name: /Energie bearbeiten/i }))
    const input = screen.getByLabelText(/Energie/i, { selector: 'input' })
    await user.clear(input)
    await user.type(input, '500')
    await user.click(screen.getByRole('button', { name: /^Speichern$/i }))

    await screen.findByText(/^500 kcal$/)
    expect(patched).toMatchObject({ kcal: 500, proteinG: 24, carbsG: 38, fatG: 9 })
  })

  it('rejects an out-of-range nutrition value with an inline error', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/recipes/r1', () =>
        HttpResponse.json({
          ...recipe,
          nutritionEstimate: {
            kcal: 420,
            proteinG: 24,
            carbsG: 38,
            fatG: 9,
          },
        }),
      ),
    )
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Nährwerte/i })

    await user.click(screen.getByRole('button', { name: /Energie bearbeiten/i }))
    const input = screen.getByLabelText(/Energie/i, { selector: 'input' })
    await user.clear(input)
    await user.type(input, '99999')
    await user.click(screen.getByRole('button', { name: /^Speichern$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/zwischen 0 und 5000/i)
  })

  // BUG-004 — the "Rezept löschen" overflow-menu item used to trigger
  // `window.confirm(...)`. It now opens the shared ConfirmDialog.
  it('BUG-004: opens ConfirmDialog instead of window.confirm when delete is chosen', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })

    await user.click(screen.getByRole('button', { name: /Mehr/i }))
    await user.click(
      await screen.findByRole('menuitem', { name: /^Löschen$/i }),
    )

    expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument()
    // Native confirm was never called.
    expect(
      screen.getByRole('heading', { name: /Rezept wirklich löschen\?/i }),
    ).toBeInTheDocument()
  })

  it('BUG-004: cancelling the ConfirmDialog does NOT fire the DELETE mutation', async () => {
    const user = userEvent.setup()
    let deleted = false
    server.use(
      http.delete('/api/recipes/r1', () => {
        deleted = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })

    await user.click(screen.getByRole('button', { name: /Mehr/i }))
    await user.click(
      await screen.findByRole('menuitem', { name: /^Löschen$/i }),
    )
    await user.click(screen.getByRole('button', { name: /^Abbrechen$/i }))
    expect(deleted).toBe(false)
  })

  it('BUG-004: confirming the ConfirmDialog issues the DELETE', async () => {
    const user = userEvent.setup()
    let deleted = false
    server.use(
      http.delete('/api/recipes/r1', () => {
        deleted = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })

    await user.click(screen.getByRole('button', { name: /Mehr/i }))
    await user.click(
      await screen.findByRole('menuitem', { name: /^Löschen$/i }),
    )
    // Confirm dialog footer has its own "Löschen" button.
    const confirmFooter = screen.getByTestId('confirm-dialog')
    const confirmBtn = confirmFooter.querySelector(
      'button:last-of-type',
    ) as HTMLButtonElement
    await user.click(confirmBtn)
    await screen.findByRole('heading', { name: /Familie/i }).catch(() => null)
    expect(deleted).toBe(true)
  })

  it('COOK-0: renders a "Jetzt kochen" entry button that links to the cook route', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })
    const cookBtn = screen.getByRole('button', { name: /^Jetzt kochen$/i })
    expect(cookBtn).toBeInTheDocument()
  })

  // ── REIMPORT-1 ─────────────────────────────────────────────────────
  //
  // The 3-dots overflow menu on a URL-imported recipe exposes a new
  // "Neu importieren" entry. Picking it opens the shared ConfirmDialog
  // (destructive-styled, German copy). Confirming fires
  // POST /api/recipes/:id/reimport and navigates to the existing
  // ImportProgressPage with the returned importId; a 409
  // version_mismatch invalidates the recipe cache and shows an inline
  // error toast.

  it('REIMPORT-1: shows "Neu importieren" entry on URL-imported recipes and opens the confirm dialog', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })

    await user.click(screen.getByRole('button', { name: /Mehr/i }))
    await user.click(
      await screen.findByRole('menuitem', { name: /Neu importieren/i }),
    )

    expect(
      await screen.findByRole('heading', {
        name: /Rezept neu importieren\?/i,
        level: 2,
      }),
    ).toBeInTheDocument()
  })

  it('REIMPORT-1: confirming the dialog POSTs to /reimport with If-Match and navigates to the progress page', async () => {
    const user = userEvent.setup()
    let seenIfMatch: string | null = null
    server.use(
      http.post('/api/recipes/r1/reimport', ({ request }) => {
        seenIfMatch = request.headers.get('If-Match')
        return HttpResponse.json({ importId: 'imp-42' }, { status: 202 })
      }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function LocationProbe() {
      const loc = useLocation()
      return <div data-testid="location">{loc.pathname}</div>
    }
    const tree = (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/groups/g1/recipes/r1']}>
          <BottomZoneProvider>
            <LocationProbe />
            <Routes>
              <Route
                path="/groups/:groupId/recipes/:recipeId"
                element={<RecipeDetailPage />}
              />
              <Route
                path="/rezepte/import/:importId"
                element={<div data-testid="progress-page">progress</div>}
              />
            </Routes>
            <BottomNav />
          </BottomZoneProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
    render(tree)

    await screen.findByRole('heading', { name: /Spätzle/ })
    await user.click(screen.getByRole('button', { name: /Mehr/i }))
    await user.click(
      await screen.findByRole('menuitem', { name: /Neu importieren/i }),
    )
    await screen.findByRole('heading', { name: /Rezept neu importieren\?/i })
    await user.click(screen.getByRole('button', { name: /Reimport starten/i }))

    await screen.findByTestId('progress-page')
    expect(seenIfMatch).toBe('W/"r1-0"')
  })

  it('REIMPORT-1: surfaces a 409 version_mismatch as an inline error without navigating', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/recipes/r1/reimport', () =>
        HttpResponse.json(
          {
            code: 'version_mismatch',
            message: 'Rezept wurde parallel geändert.',
            current: { id: 'r1', version: 1 },
          },
          { status: 409 },
        ),
      ),
    )
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })
    await user.click(screen.getByRole('button', { name: /Mehr/i }))
    await user.click(
      await screen.findByRole('menuitem', { name: /Neu importieren/i }),
    )
    await screen.findByRole('heading', { name: /Rezept neu importieren\?/i })
    await user.click(screen.getByRole('button', { name: /Reimport starten/i }))

    // Conflict copy surfaces inline for the user; the progress page is
    // NOT mounted in this wiring but the dialog closes on conflict so
    // any follow-up mutation can be re-dispatched.
    expect(
      await screen.findByText(/parallel geändert/i, {}, { timeout: 3000 }),
    ).toBeInTheDocument()
  })

  it('fires the mark-as-cooked mutation when the sticky "Jetzt gekocht" button is tapped', async () => {
    const user = userEvent.setup()
    let cookedAt: string | null = null
    server.use(
      http.post('/api/recipes/r1/cook', () => {
        cookedAt = '2026-04-18T12:00:00Z'
        return HttpResponse.json({ ...recipe, lastCookedAt: cookedAt })
      }),
    )
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })
    await user.click(screen.getByRole('button', { name: /Jetzt gekocht/i }))
    // Status message surfaces once the mutation resolves.
    expect(
      await screen.findByRole('status', { name: '' }, { timeout: 2000 })
        .catch(() => null) ?? (await screen.findByText(/als gekocht markiert/i)),
    ).toBeTruthy()
    expect(cookedAt).toBe('2026-04-18T12:00:00Z')
  })
})
