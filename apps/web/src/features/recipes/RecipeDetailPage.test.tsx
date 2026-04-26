import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { RecipeDetailDto } from '@shared-cookbook/shared'
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
  // COMP-2 — single-default component wraps the pre-COMP-2 flat
  // ingredient+step fixture so the detail page renders identically.
  components: [
    {
      id: 'c1',
      position: 0,
      label: null,
      ingredients: [
        { id: 'i1', position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
        { id: 'i2', position: 1, quantity: null, unit: 'Prise', name: 'Salz', note: null, scalable: false },
      ],
      steps: [
        { id: 's1', position: 0, content: 'Mehl in eine Schüssel geben.' },
        { id: 's2', position: 1, content: 'Eier und Salz hinzufügen.' },
      ],
    },
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

  // 2026-04-21 Nav-bug fix — the reimport-trigger on RecipeDetailPage
  // must REPLACE the detail-page history entry (not push on top of it).
  // Otherwise the post-Done redirect (which itself already uses replace)
  // leaves a duplicate /groups/:g/recipes/:r on the stack, and the
  // browser Back button eats one "invisible" back before landing on
  // the group's recipe list as the user expects.
  it('REIMPORT nav-bug: replacing detail-page entry means Back from progress lands before the detail', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/recipes/r1/reimport', () =>
        HttpResponse.json({ importId: 'imp-42' }, { status: 202 }),
      ),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function LocationProbe() {
      const loc = useLocation()
      const navigate = useNavigate()
      return (
        <>
          <div data-testid="location">{loc.pathname}</div>
          <button type="button" onClick={() => navigate(-1)} data-testid="back">
            back
          </button>
        </>
      )
    }
    const tree = (
      <QueryClientProvider client={client}>
        <MemoryRouter
          initialEntries={['/groups/g1', '/groups/g1/recipes/r1']}
          initialIndex={1}
        >
          <BottomZoneProvider>
            <LocationProbe />
            <Routes>
              <Route path="/groups/:groupId" element={<div>group-list</div>} />
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

    // Simulate browser Back after the reimport-navigate. If replace was
    // used, the progress-page entry sits where the detail-page was, and
    // Back lands on /groups/g1 (the group list). If push was used, Back
    // lands back on the detail page's /groups/g1/recipes/r1 — i.e. the
    // user has to click Back twice to actually leave the detail.
    await user.click(screen.getByTestId('back'))
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/groups/g1')
    })
  })

  // 2026-04-26 Back-button nav-bug — v0.15.0 introduced an
  // ExternalLink on meal-plan slots that deep-links into the recipe-
  // detail. Tapping Back on the detail page used to hardcode-navigate
  // to `/groups/:g`, eating the meal-plan entry the user came from.
  // Fix: pop the history stack via `navigate(-1)` when there IS
  // history, fall back to the group page only on a cold deep-link.
  it('Back-button: pops history when navigated in from another route (e.g. meal plan)', async () => {
    const user = userEvent.setup()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function LocationProbe() {
      const loc = useLocation()
      return <div data-testid="location">{loc.pathname}</div>
    }
    const tree = (
      <QueryClientProvider client={client}>
        <MemoryRouter
          initialEntries={[
            '/groups/g1/mealplan/2026-04-20',
            '/groups/g1/recipes/r1',
          ]}
          initialIndex={1}
        >
          <BottomZoneProvider>
            <LocationProbe />
            <Routes>
              <Route path="/groups/:groupId" element={<div>group-list</div>} />
              <Route
                path="/groups/:groupId/mealplan/:weekStart"
                element={<div data-testid="mealplan-page">mealplan</div>}
              />
              <Route
                path="/groups/:groupId/recipes/:recipeId"
                element={<RecipeDetailPage />}
              />
            </Routes>
            <BottomNav />
          </BottomZoneProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
    render(tree)

    await screen.findByRole('heading', { name: /Spätzle/ })
    await user.click(screen.getByRole('button', { name: /Zurück/i }))

    await screen.findByTestId('mealplan-page')
    expect(screen.getByTestId('location').textContent).toBe(
      '/groups/g1/mealplan/2026-04-20',
    )
  })

  it('Back-button: falls back to the group page on a cold deep-link (no history)', async () => {
    const user = userEvent.setup()
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
                path="/groups/:groupId"
                element={<div data-testid="group-page">group</div>}
              />
              <Route
                path="/groups/:groupId/recipes/:recipeId"
                element={<RecipeDetailPage />}
              />
            </Routes>
            <BottomNav />
          </BottomZoneProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
    render(tree)

    await screen.findByRole('heading', { name: /Spätzle/ })
    await user.click(screen.getByRole('button', { name: /Zurück/i }))

    await screen.findByTestId('group-page')
    expect(screen.getByTestId('location').textContent).toBe('/groups/g1')
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

  // ── TABLET-3 — Recipe-Detail two-column layout at md:+ ───────────────
  //
  // At `md:+` the body below the hero refactors into a two-column grid:
  // left column is ingredients + nutrition + history (sticky), right
  // column is the steps list (scrollable). Mobile (< md) stays a single
  // flow so the DOM-order invariant (ingredients before steps) remains.

  it('TABLET-3: renders a left column and a right column with the right Tailwind classes', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })

    const left = screen.getByTestId('recipe-detail-left')
    const right = screen.getByTestId('recipe-detail-right')
    expect(left).toBeInTheDocument()
    expect(right).toBeInTheDocument()
    // Sticky affordance applies at md:+ only — mobile stays normal flow.
    expect(left.className).toMatch(/md:sticky/)
    // The body wrapper switches to a two-column grid at md:+.
    const grid = screen.getByTestId('recipe-detail-grid')
    expect(grid.className).toMatch(/md:grid/)
    expect(grid.className).toMatch(/md:grid-cols-\[var\(--split-left-width\)_1fr\]/)
  })

  it('TABLET-3: ingredients appear before steps in DOM order so the mobile flow stays intact', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })

    const ingredientsHeading = screen.getByRole('heading', { name: /^Zutaten/i })
    const stepsHeading = screen.getByRole('heading', { name: /^Zubereitung$/i })
    // `compareDocumentPosition` returns FOLLOWING (bit 0x04) when the
    // argument comes AFTER the reference node — the assertion here is
    // "steps follow ingredients in document order". This invariant holds
    // for both the mobile single-column flow AND the md:+ two-column
    // grid (the left column always precedes the right in the DOM).
    const rel = ingredientsHeading.compareDocumentPosition(stepsHeading)
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('TABLET-3: both ingredients and steps render in the same tree (no conditional hide)', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })
    // Regression guard: the refactor must not gate one column behind a
    // JS viewport check — both surfaces must be in the DOM so Tailwind
    // responsive classes alone decide the presentation.
    expect(screen.getByRole('heading', { name: /^Zutaten/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^Zubereitung$/i })).toBeInTheDocument()
    expect(screen.getByText('Mehl in eine Schüssel geben.')).toBeInTheDocument()
    expect(screen.getByText('Salz')).toBeInTheDocument()
  })

  // ── COMP-2 — component grouping on the detail page ───────────────

  it('COMP-2: single-default recipe renders without any component-header <h3>s (DOM unchanged from pre-COMP-2)', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })
    // No component-heading chrome for the single-default case — the
    // detail page must render exactly like the pre-COMP-2 flat layout.
    expect(
      screen.queryAllByTestId('recipe-detail-component-heading'),
    ).toHaveLength(0)
  })

  it('COMP-2: multi-component recipe renders each component as an <h3> section (Chipotle Sauce + Hauptgericht)', async () => {
    server.use(
      http.get('/api/recipes/r1', () =>
        HttpResponse.json({
          ...recipe,
          components: [
            {
              id: 'c1',
              position: 0,
              label: 'Chipotle Sauce',
              ingredients: [
                { id: 'i-s1', position: 0, quantity: 2, unit: 'EL', name: 'Honig', note: null, scalable: true },
              ],
              steps: [
                { id: 'st-s1', position: 0, content: 'Sauce mischen.' },
              ],
            },
            {
              id: 'c2',
              position: 1,
              label: null,
              ingredients: [
                { id: 'i-m1', position: 0, quantity: 2, unit: 'Stück', name: 'Tortilla', note: null, scalable: true },
              ],
              steps: [
                { id: 'st-m1', position: 0, content: 'Tortilla anbraten.' },
              ],
            },
          ],
        }),
      ),
    )
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })

    // The two component sections surface under their own headings.
    // The null-labelled component in a multi-component recipe falls
    // back to the German "Hauptgericht" placeholder.
    const headings = screen.getAllByTestId('recipe-detail-component-heading')
    // Ingredients pane + steps pane each render a copy of the heading,
    // so we expect 4 headings total (2 components × 2 sections).
    const texts = headings.map((h) => h.textContent)
    expect(texts).toContain('Chipotle Sauce')
    expect(texts).toContain('Hauptgericht')
    // Per-component ingredients + steps are visible.
    expect(screen.getByText('Honig')).toBeInTheDocument()
    expect(screen.getByText('Tortilla')).toBeInTheDocument()
    expect(screen.getByText('Sauce mischen.')).toBeInTheDocument()
    expect(screen.getByText('Tortilla anbraten.')).toBeInTheDocument()
  })

  it('COMP-2: portion slider scales ingredients across all components uniformly', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/recipes/r1', () =>
        HttpResponse.json({
          ...recipe,
          defaultServings: 2,
          components: [
            {
              id: 'c1',
              position: 0,
              label: 'Sauce',
              ingredients: [
                { id: 'i1', position: 0, quantity: 100, unit: 'g', name: 'Zucker', note: null, scalable: true },
              ],
              steps: [{ id: 's1', position: 0, content: 'Sauce.' }],
            },
            {
              id: 'c2',
              position: 1,
              label: null,
              ingredients: [
                { id: 'i2', position: 0, quantity: 200, unit: 'g', name: 'Mehl', note: null, scalable: true },
              ],
              steps: [{ id: 's2', position: 0, content: 'Main.' }],
            },
          ],
        }),
      ),
    )
    render(withProviders('/groups/g1/recipes/r1'))
    await screen.findByRole('heading', { name: /Spätzle/ })

    // Initial render at 2 portions: 100 g + 200 g.
    expect(await screen.findByText(/^100 g$/)).toBeInTheDocument()
    expect(screen.getByText(/^200 g$/)).toBeInTheDocument()

    // Bump portions to 4 → quantities double across both components.
    const plus = screen.getByRole('button', { name: /Portion erhöhen/i })
    await user.click(plus)
    await user.click(plus)
    await screen.findByText(/^200 g$/)
    await screen.findByText(/^400 g$/)
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

  // ── COVER-0 Slice E — "Cover ändern" button + modal ───────────────

  describe('COVER-0 Slice E — "Cover ändern" button + modal', () => {
    const importId = 'imp-1'
    const candidates = [
      {
        stagedPhotoId: 'sp-0',
        signedUrl: 'https://cdn.example/c0.jpg',
        contentType: 'image/jpeg',
        candidateOrder: 0,
        expiresAt: '2026-04-29T00:00:00Z',
      },
      {
        stagedPhotoId: 'sp-1',
        signedUrl: 'https://cdn.example/c1.jpg',
        contentType: 'image/jpeg',
        candidateOrder: 1,
        expiresAt: '2026-04-29T00:00:00Z',
      },
      {
        stagedPhotoId: 'sp-2',
        signedUrl: 'https://cdn.example/c2.jpg',
        contentType: 'image/jpeg',
        candidateOrder: 2,
        expiresAt: '2026-04-29T00:00:00Z',
      },
    ]

    it('hides the button when the recipe has no originating import (404)', async () => {
      server.use(
        http.get('/api/recipes/r1/origin-import', () =>
          HttpResponse.json(
            { code: 'not_found', message: 'no origin' },
            { status: 404 },
          ),
        ),
      )
      render(withProviders('/groups/g1/recipes/r1'))
      await screen.findByRole('heading', { name: /Spätzle/ })
      // No button regardless of how long we wait — settle after the
      // 404 resolves.
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /Cover ändern/i }))
          .not.toBeInTheDocument()
      })
    })

    it('hides the button when the candidates query returns 410 Gone', async () => {
      server.use(
        http.get('/api/recipes/r1/origin-import', () =>
          HttpResponse.json({ importId }),
        ),
        http.get(`/api/imports/${importId}/candidates`, () =>
          HttpResponse.json(
            { code: 'candidates_expired', message: 'gone' },
            { status: 410 },
          ),
        ),
      )
      render(withProviders('/groups/g1/recipes/r1'))
      await screen.findByRole('heading', { name: /Spätzle/ })
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /Cover ändern/i }))
          .not.toBeInTheDocument()
      })
    })

    it('hides the button when the caller is not the recipe owner', async () => {
      // Different user id — recipe.createdByUserId is u1.
      useAuthStore.setState({
        accessToken: 't',
        user: { id: 'u-other', email: 'o@ex.com', displayName: 'O', role: 'User' },
      })
      server.use(
        http.get('/api/recipes/r1/origin-import', () =>
          HttpResponse.json({ importId }),
        ),
        http.get(`/api/imports/${importId}/candidates`, () =>
          HttpResponse.json({ candidates }),
        ),
      )
      render(withProviders('/groups/g1/recipes/r1'))
      await screen.findByRole('heading', { name: /Spätzle/ })
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /Cover ändern/i }))
          .not.toBeInTheDocument()
      })
    })

    it('renders the button when owner + origin-import + candidates all resolve', async () => {
      server.use(
        http.get('/api/recipes/r1/origin-import', () =>
          HttpResponse.json({ importId }),
        ),
        http.get(`/api/imports/${importId}/candidates`, () =>
          HttpResponse.json({ candidates }),
        ),
      )
      render(withProviders('/groups/g1/recipes/r1'))
      await screen.findByRole('heading', { name: /Spätzle/ })
      expect(
        await screen.findByRole('button', { name: /Cover ändern/i }),
      ).toBeInTheDocument()
    })

    it('opens the modal with the candidate grid when the button is tapped', async () => {
      const user = userEvent.setup()
      server.use(
        http.get('/api/recipes/r1/origin-import', () =>
          HttpResponse.json({ importId }),
        ),
        http.get(`/api/imports/${importId}/candidates`, () =>
          HttpResponse.json({ candidates }),
        ),
      )
      render(withProviders('/groups/g1/recipes/r1'))
      await screen.findByRole('heading', { name: /Spätzle/ })
      await user.click(
        await screen.findByRole('button', { name: /Cover ändern/i }),
      )
      expect(
        await screen.findByRole('heading', { name: /^Cover ändern$/i, level: 2 }),
      ).toBeInTheDocument()
      // Every candidate renders a tile (use aria-label "Auswählen"
      // from ImportCandidatesGrid).
      const tiles = await screen.findAllByRole('button', {
        name: /(Auswählen|Abwählen|Cover-Bild|Zum Cover machen)/i,
      })
      expect(tiles.length).toBeGreaterThanOrEqual(candidates.length)
    })

    it('Speichern POSTs to /cover with the tapped staged-photo id and closes the modal', async () => {
      const user = userEvent.setup()
      let seenBody: unknown = null
      server.use(
        http.get('/api/recipes/r1/origin-import', () =>
          HttpResponse.json({ importId }),
        ),
        http.get(`/api/imports/${importId}/candidates`, () =>
          HttpResponse.json({ candidates }),
        ),
        http.post('/api/recipes/r1/cover', async ({ request }) => {
          seenBody = await request.json()
          return HttpResponse.json({ ...recipe, photos: ['fake://new-cover.jpg'] })
        }),
      )
      render(withProviders('/groups/g1/recipes/r1'))
      await screen.findByRole('heading', { name: /Spätzle/ })
      await user.click(
        await screen.findByRole('button', { name: /Cover ändern/i }),
      )
      await screen.findByRole('heading', { name: /^Cover ändern$/i, level: 2 })

      // Pick candidate [1] via its star icon (Zum Cover machen). The
      // grid's tile body also counts as selection, but star is the
      // unambiguous "this becomes the cover" signal.
      const coverStars = await screen.findAllByRole('button', {
        name: /Zum Cover machen/i,
      })
      await user.click(coverStars[0])

      // Explicit Speichern commits.
      await user.click(screen.getByRole('button', { name: /^Speichern$/i }))

      await waitFor(() => {
        expect(seenBody).toMatchObject({ stagedPhotoId: 'sp-1' })
      })
      // Modal closes on success.
      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { name: /^Cover ändern$/i, level: 2 }),
        ).not.toBeInTheDocument()
      })
    })

    it('410 mid-session: modal closes, banner appears, button disappears', async () => {
      const user = userEvent.setup()
      let candidatesCallCount = 0
      server.use(
        http.get('/api/recipes/r1/origin-import', () =>
          HttpResponse.json({ importId }),
        ),
        http.get(`/api/imports/${importId}/candidates`, () => {
          candidatesCallCount++
          // First call (before user opens modal) returns candidates;
          // second call (triggered by the invalidate after a 410 from
          // swap) returns 410.
          if (candidatesCallCount === 1) {
            return HttpResponse.json({ candidates })
          }
          return HttpResponse.json(
            { code: 'candidates_expired', message: 'gone' },
            { status: 410 },
          )
        }),
        http.post('/api/recipes/r1/cover', () =>
          HttpResponse.json(
            { code: 'candidates_expired', message: 'gone' },
            { status: 410 },
          ),
        ),
      )
      render(withProviders('/groups/g1/recipes/r1'))
      await screen.findByRole('heading', { name: /Spätzle/ })
      await user.click(
        await screen.findByRole('button', { name: /Cover ändern/i }),
      )
      await screen.findByRole('heading', { name: /^Cover ändern$/i, level: 2 })

      const coverStars = await screen.findAllByRole('button', {
        name: /Zum Cover machen/i,
      })
      await user.click(coverStars[0])
      await user.click(screen.getByRole('button', { name: /^Speichern$/i }))

      // Modal closes.
      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { name: /^Cover ändern$/i, level: 2 }),
        ).not.toBeInTheDocument()
      })
      // Banner surfaces.
      expect(
        await screen.findByText(/Import-Kandidaten sind nicht mehr verfügbar/i),
      ).toBeInTheDocument()
      // Button disappears after the 410.
      await waitFor(() => {
        expect(
          screen.queryByRole('button', { name: /Cover ändern/i }),
        ).not.toBeInTheDocument()
      })
    })
  })
})
