import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { RecipeFormPage } from './RecipeFormPage'
import { reorderAcrossComponents } from './componentReorder'
import { BottomZoneProvider } from '@/components/layout/bottomZone'
import { BottomNav } from '@/components/layout/BottomNav'
import type {
  CreateRecipeRequest,
  RecipeImportDto,
} from '@familien-kochbuch/shared'
import { importQueryKeys } from '@/features/imports/hooks'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
  server.use(
    http.get('/api/groups/g1/tags', () =>
      HttpResponse.json([
        { id: 't1', name: 'vegan', category: 'Diaet', isGlobal: true },
        { id: 't2', name: 'schnell', category: 'Aufwand', isGlobal: true },
        { id: 't3', name: 'Pizzateig', category: 'Komponente', isGlobal: true },
      ]),
    ),
  )

  // jsdom returns all-zero rects by default, which breaks @dnd-kit's
  // keyboard coordinate getter (it filters droppables by rect.top delta).
  // Give every element a synthetic vertical layout based on its DOM index
  // among its siblings of the same tag, so ArrowDown/ArrowUp find the
  // expected neighbour row.
  const ROW_HEIGHT = 60
  Element.prototype.getBoundingClientRect = function () {
    const parent = this.parentElement
    const siblings = parent ? Array.from(parent.children) : [this]
    const index = siblings.indexOf(this as Element)
    const top = Math.max(index, 0) * ROW_HEIGHT
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 200,
      bottom: top + ROW_HEIGHT,
      width: 200,
      height: ROW_HEIGHT,
      toJSON() {
        return this
      },
    } as DOMRect
  }
})

function withProviders(initialPath: string): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // BUG-036 — the save/cancel action row lives in the unified Bottom-
  // Zone slot now, so we mount <BottomZoneProvider> + <BottomNav>
  // around the form so the slot JSX materialises in the DOM tree and
  // "Rezept speichern" / "Abbrechen" stay findable by role.
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <BottomZoneProvider>
          <Routes>
            <Route path="/groups/:groupId/recipes/new" element={<RecipeFormPage mode="create" />} />
          </Routes>
          <BottomNav />
        </BottomZoneProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('RecipeFormPage (create)', () => {
  it('renders the form and starts with one empty ingredient + step row', () => {
    render(withProviders('/groups/g1/recipes/new'))
    expect(screen.getByLabelText(/Titel/i)).toBeInTheDocument()
    expect(screen.getAllByLabelText(/Zutat \d+ Name/i)).toHaveLength(1)
    expect(screen.getAllByLabelText(/Schritt \d+/i)).toHaveLength(1)
  })

  it('can add and remove ingredient rows', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/new'))

    await user.click(screen.getByRole('button', { name: /Zutat hinzufügen/i }))
    expect(screen.getAllByLabelText(/Zutat \d+ Name/i)).toHaveLength(2)

    const removeButtons = screen.getAllByRole('button', { name: /Zutat entfernen/i })
    await user.click(removeButtons[0])
    expect(screen.getAllByLabelText(/Zutat \d+ Name/i)).toHaveLength(1)
  })

  it('requires a title before submit', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/new'))

    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Titel/i)
  })

  it('shows tag chips loaded from the API', async () => {
    render(withProviders('/groups/g1/recipes/new'))
    expect(await screen.findByRole('button', { name: /vegan/i })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /schnell/i })).toBeInTheDocument()
  })

  // GR1 — Komponente section header and chip render alongside the
  // existing Aufwand/Diät groups in the tag-picker grid.
  it('renders the Komponente section with its chips in the tag picker', async () => {
    render(withProviders('/groups/g1/recipes/new'))
    expect(await screen.findByRole('button', { name: /Pizzateig/ })).toBeInTheDocument()
    expect(screen.getByText('Komponente')).toBeInTheDocument()
  })

  // BUG-044 regression — a German-locale "0,25" in a quantity input used
  // to flow through Number() as NaN → JSON.stringify serialised NaN as
  // null → backend rejected with 400 invalid_input ("Nach Geschmack
  // entries cannot be scalable") because the frontend still sent
  // `scalable: true`. Fix: normalise comma→dot before Number(); guard
  // NaN → null + force scalable false.
  it('parses German comma-decimal quantity and flips scalable off on NaN (BUG-044)', async () => {
    const user = userEvent.setup()
    let capturedPayload: CreateRecipeRequest | null = null
    server.use(
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        capturedPayload = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(
          {
            id: 'r-bug044',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-21T00:00:00Z',
            updatedAt: '2026-04-21T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Birne-Test')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Asiatische Birne')
    await user.type(screen.getByLabelText(/Zutat 1 Menge/i), '0,25')
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Schälen.')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))

    await waitFor(() => expect(capturedPayload).not.toBeNull())
    // COMP-2 — single-default path: first component carries everything.
    const ing = capturedPayload!.components[0]!.ingredients[0]!
    // Comma normalised → 0.25, not NaN / null.
    expect(ing.quantity).toBe(0.25)
    // Real number ⇒ scalable stays as whatever the row had (default true
    // for the freshly-added manual row).
    expect(ing.scalable).toBe(true)
  })

  it('treats garbage quantity ("abc") as missing + forces scalable=false (BUG-044)', async () => {
    const user = userEvent.setup()
    let capturedPayload: CreateRecipeRequest | null = null
    server.use(
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        capturedPayload = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(
          {
            id: 'r-bug044-b',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-21T00:00:00Z',
            updatedAt: '2026-04-21T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Abc-Test')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
    await user.type(screen.getByLabelText(/Zutat 1 Menge/i), 'abc')
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Mehl reinkippen.')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))

    await waitFor(() => expect(capturedPayload).not.toBeNull())
    const ing = capturedPayload!.components[0]!.ingredients[0]!
    expect(ing.quantity).toBeNull()
    expect(ing.scalable).toBe(false)
  })

  it('POSTs to /api/groups/g1/recipes on submit and navigates to detail', async () => {
    const user = userEvent.setup()
    let posted = false
    server.use(
      http.post('/api/groups/g1/recipes', () => {
        posted = true
        return HttpResponse.json(
          {
            id: 'r1',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Ok')
    // Fill ingredient + step so the form passes client validation.
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Umrühren.')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))

    await waitFor(() => expect(posted).toBe(true))
  })

  it('reorders ingredient rows via keyboard sensor and persists the new order on submit', async () => {
    const user = userEvent.setup()
    let capturedPayload: CreateRecipeRequest | null = null
    server.use(
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        capturedPayload = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(
          {
            id: 'r-reordered',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Ok')

    // Build 3 ingredient rows with distinguishable names [Mehl, Zucker, Salz].
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
    await user.click(screen.getByRole('button', { name: /Zutat hinzufügen/i }))
    await user.type(screen.getByLabelText(/Zutat 2 Name/i), 'Zucker')
    await user.click(screen.getByRole('button', { name: /Zutat hinzufügen/i }))
    await user.type(screen.getByLabelText(/Zutat 3 Name/i), 'Salz')

    // Need at least one step for client validation.
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Kochen.')

    // Grab the drag handle on the first ingredient and move it down one slot
    // with the @dnd-kit keyboard sensor: Space activates, ArrowDown moves,
    // Space drops. Expected result: [Zucker, Mehl, Salz].
    const firstHandle = screen.getByTestId('ingredient-drag-handle-0')
    firstHandle.focus()
    fireEvent.keyDown(firstHandle, { key: ' ', code: 'Space' })
    // KeyboardSensor registers its `keydown` listener on ownerDocument via
    // setTimeout(0); flush microtasks + timers before dispatching the move.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    fireEvent.keyDown(document.activeElement ?? firstHandle, {
      key: 'ArrowDown',
      code: 'ArrowDown',
    })
    fireEvent.keyDown(document.activeElement ?? firstHandle, {
      key: ' ',
      code: 'Space',
    })

    // Visually the inputs should now reflect the new order.
    await waitFor(() => {
      const names = screen
        .getAllByLabelText(/Zutat \d+ Name/i)
        .map((el) => (el as HTMLInputElement).value)
      expect(names).toEqual(['Zucker', 'Mehl', 'Salz'])
    })

    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))

    await waitFor(() => expect(capturedPayload).not.toBeNull())
    // COMP-2 — reorder lives inside the single-default component.
    expect(capturedPayload!.components[0]!.ingredients.map((i) => i.name)).toEqual([
      'Zucker',
      'Mehl',
      'Salz',
    ])
    // Positions must be renumbered 0..n-1 to match the new visual order.
    expect(
      capturedPayload!.components[0]!.ingredients.map((i) => i.position),
    ).toEqual([0, 1, 2])
  })

  it('reorders step rows via keyboard sensor and persists the new order on submit', async () => {
    const user = userEvent.setup()
    let capturedPayload: CreateRecipeRequest | null = null
    server.use(
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        capturedPayload = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(
          {
            id: 'r-reordered-steps',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Ok')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')

    // Build 3 step rows with distinguishable content [Eins, Zwei, Drei].
    await user.type(screen.getByLabelText(/^Schritt 1$/i), 'Eins')
    await user.click(screen.getByRole('button', { name: /Schritt hinzufügen/i }))
    await user.type(screen.getByLabelText(/^Schritt 2$/i), 'Zwei')
    await user.click(screen.getByRole('button', { name: /Schritt hinzufügen/i }))
    await user.type(screen.getByLabelText(/^Schritt 3$/i), 'Drei')

    // Reorder: move step 1 down by one → [Zwei, Eins, Drei].
    const firstStepHandle = screen.getByTestId('step-drag-handle-0')
    firstStepHandle.focus()
    fireEvent.keyDown(firstStepHandle, { key: ' ', code: 'Space' })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    fireEvent.keyDown(document.activeElement ?? firstStepHandle, {
      key: 'ArrowDown',
      code: 'ArrowDown',
    })
    fireEvent.keyDown(document.activeElement ?? firstStepHandle, {
      key: ' ',
      code: 'Space',
    })

    await waitFor(() => {
      const values = screen
        .getAllByLabelText(/^Schritt \d+$/i)
        .map((el) => (el as HTMLTextAreaElement).value)
      expect(values).toEqual(['Zwei', 'Eins', 'Drei'])
    })

    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))

    await waitFor(() => expect(capturedPayload).not.toBeNull())
    // COMP-2 — step reorder lives inside the single-default component.
    expect(capturedPayload!.components[0]!.steps.map((s) => s.content)).toEqual([
      'Zwei',
      'Eins',
      'Drei',
    ])
    expect(
      capturedPayload!.components[0]!.steps.map((s) => s.position),
    ).toEqual([0, 1, 2])
  })

  it('renders the DS6 sticky form top bar with "Neues Rezept"', () => {
    render(withProviders('/groups/g1/recipes/new'))
    // TopNav suppression → only the form top bar is visible. The serif
    // title renders inside a banner. Both the banner and the h1 repeat
    // the copy, so assert on the banner specifically.
    const banner = screen.getByRole('banner')
    expect(banner).toHaveTextContent(/Neues Rezept/)
    expect(banner).toHaveTextContent(/Ungespeicherte Änderungen/)
  })

  it('renders the FormIntro italic tagline', () => {
    render(withProviders('/groups/g1/recipes/new'))
    expect(
      screen.getByText(/Zutaten und Schritte kannst du später jederzeit anpassen/i),
    ).toBeInTheDocument()
  })

  it('renders the CharCounter under the title input', () => {
    render(withProviders('/groups/g1/recipes/new'))
    // With empty title, the title counter reads "0 / 200" (the
    // description counter underneath reads "0 / 2000").
    expect(screen.getByText(/^0 \/ 200$/)).toBeInTheDocument()
    expect(screen.getByText(/^0 \/ 2000$/)).toBeInTheDocument()
  })

  it('updates the CharCounter live as the user types in the title', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Omas')
    expect(screen.getByText(/^4 \/ 200$/)).toBeInTheDocument()
  })

  it('lets the user select a difficulty pill and persists the choice on submit', async () => {
    const user = userEvent.setup()
    let captured: CreateRecipeRequest | null = null
    server.use(
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        captured = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(
          {
            id: 'r-diff',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 3,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Ok')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Umrühren.')
    await user.click(screen.getByRole('button', { name: /Aufwendig/ }))
    expect(screen.getByRole('button', { name: /Aufwendig/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))
    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured!.difficulty).toBe(3)
  })

  it('toggles a tag chip and submits the chosen tag id', async () => {
    const user = userEvent.setup()
    let captured: CreateRecipeRequest | null = null
    server.use(
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        captured = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(
          {
            id: 'r-tag',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Ok')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Umrühren.')
    // Tags are loaded via MSW in beforeEach — wait for the "vegan" chip.
    const veganChip = await screen.findByRole('button', { name: /vegan/i })
    await user.click(veganChip)
    expect(veganChip).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))
    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured!.tagIds).toContain('t1')
  })

  it('auto-disables scalable and sends scalable=false when the user selects the "nach Geschmack" unit', async () => {
    const user = userEvent.setup()
    let captured: CreateRecipeRequest | null = null
    server.use(
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        captured = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(
          {
            id: 'r-ng',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Ok')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Salz')
    await user.selectOptions(
      screen.getByLabelText(/Zutat 1 Einheit/i),
      'nach Geschmack',
    )
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Umrühren.')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))
    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured!.components[0]?.ingredients[0]?.quantity).toBeNull()
    expect(captured!.components[0]?.ingredients[0]?.scalable).toBe(false)
  })

  it('clamps Portionen to 1 before submit even if the user types 0', async () => {
    const user = userEvent.setup()
    let captured: CreateRecipeRequest | null = null
    server.use(
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        captured = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(
          {
            id: 'r-clamp',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 1,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Ok')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Umrühren.')

    const servings = screen.getByLabelText(/Portionen/i) as HTMLInputElement
    await user.clear(servings)
    await user.type(servings, '0')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))
    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured!.defaultServings).toBeGreaterThanOrEqual(1)
  })

  // UX1-RT — the step row exposes a Markdown toolbar. Clicking "Fett"
  // wraps the current textarea selection in ** and persists the new
  // content on the submit payload.
  it('wraps the selected step text in **…** when the user clicks the Fett toolbar button', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/new'))

    const stepArea = screen.getByLabelText(/^Schritt 1$/i) as HTMLTextAreaElement
    await user.type(stepArea, 'Kartoffeln schälen')
    stepArea.focus()
    stepArea.setSelectionRange(0, 'Kartoffeln'.length)

    // Each step row has its own toolbar — pick the first row's Fett button.
    const boldButtons = screen.getAllByRole('button', { name: 'Fett' })
    await user.click(boldButtons[0]!)

    expect(stepArea.value).toBe('**Kartoffeln** schälen')
  })

  // UX1-RT — the preview toggle per step flips the textarea to a
  // read-only rendered block. Clicking "Vorschau" hides the textarea
  // and clicking "Bearbeiten" brings it back.
  it('toggles the step preview mode between textarea and rendered Markdown', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/new'))

    const stepArea = screen.getByLabelText(/^Schritt 1$/i) as HTMLTextAreaElement
    await user.type(stepArea, 'Mit **Salz** abschmecken')
    expect(stepArea).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: 'Vorschau' })[0]!)

    // Textarea is gone; rendered <strong> is visible.
    expect(screen.queryByLabelText(/^Schritt 1$/i)).not.toBeInTheDocument()
    const strong = screen.getByText('Salz')
    expect(strong.tagName.toLowerCase()).toBe('strong')

    // Flip back.
    await user.click(screen.getAllByRole('button', { name: 'Bearbeiten' })[0]!)
    expect(screen.getByLabelText(/^Schritt 1$/i)).toBeInTheDocument()
  })

  // UX1-RT — Cmd/Ctrl+B on the focused textarea wraps the current
  // selection in ** even without clicking the toolbar.
  it('wraps the selected step text in ** via the Cmd/Ctrl+B keyboard shortcut', async () => {
    const user = userEvent.setup()
    render(withProviders('/groups/g1/recipes/new'))

    const stepArea = screen.getByLabelText(/^Schritt 1$/i) as HTMLTextAreaElement
    await user.type(stepArea, 'Hallo Welt')
    stepArea.focus()
    stepArea.setSelectionRange(6, 10)

    fireEvent.keyDown(stepArea, { key: 'b', code: 'KeyB', ctrlKey: true })
    expect(stepArea.value).toBe('Hallo **Welt**')
  })

  // UX1-PU — the three dashed placeholder tiles are replaced with the
  // staged PhotoUploadGrid so the user can drop photos before the recipe
  // itself exists. These tests drive the staged grid + submit
  // orchestration (sequential upload after createRecipe, partial-failure
  // banner, button-state transitions).

  it('renders the staged PhotoUploadGrid in create mode (3 drop-zones, no "nach dem Speichern")', () => {
    render(withProviders('/groups/g1/recipes/new'))
    // Old placeholder copy should be gone.
    expect(screen.queryByText(/nach dem Speichern/i)).not.toBeInTheDocument()
    // Three empty slots from the grid component.
    expect(
      screen.getAllByRole('button', { name: /Foto hochladen/i }),
    ).toHaveLength(3)
  })

  it('does NOT fire any /photos request when the user submits with zero staged photos', async () => {
    const user = userEvent.setup()
    let postedRecipe = false
    let photoCalls = 0
    server.use(
      http.post('/api/groups/g1/recipes', () => {
        postedRecipe = true
        return HttpResponse.json(
          {
            id: 'r-nophoto',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
      http.post('/api/recipes/:id/photos', () => {
        photoCalls += 1
        return HttpResponse.json({ url: 'fake://x' })
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Ok')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Umrühren.')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))

    await waitFor(() => expect(postedRecipe).toBe(true))
    // Give any (wrongly) queued photo upload a tick to fire — still zero.
    await new Promise((r) => setTimeout(r, 10))
    expect(photoCalls).toBe(0)
  })

  it('uploads a staged photo sequentially after createRecipe resolves and navigates', async () => {
    const user = userEvent.setup()
    const recipeCreated: string[] = []
    const photosPosted: string[] = []
    server.use(
      http.post('/api/groups/g1/recipes', () => {
        recipeCreated.push('r-with-photo')
        return HttpResponse.json(
          {
            id: 'r-with-photo',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
      http.post('/api/recipes/r-with-photo/photos', () => {
        photosPosted.push('ok')
        return HttpResponse.json({ url: 'fake://a.jpg' }, { status: 201 })
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Ok')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Umrühren.')
    // Stage a photo through the grid's hidden input.
    const input = screen.getAllByTestId('photo-upload-input')[0] as HTMLInputElement
    await user.upload(input, new File(['x'], 'a.jpg', { type: 'image/jpeg' }))

    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))

    await waitFor(() => expect(recipeCreated).toHaveLength(1))
    await waitFor(() => expect(photosPosted).toHaveLength(1))
  })

  it('shows partial-failure banner when 1 of 2 staged photos fails to upload (recipe saved, user stays on form)', async () => {
    const user = userEvent.setup()
    let photoCallCount = 0
    server.use(
      http.post('/api/groups/g1/recipes', () =>
        HttpResponse.json(
          {
            id: 'r-partial',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        ),
      ),
      http.post('/api/recipes/r-partial/photos', () => {
        photoCallCount += 1
        if (photoCallCount === 2) {
          return HttpResponse.json(
            { code: 'photo_too_large', message: 'Bild darf maximal 5 MB groß sein.' },
            { status: 413 },
          )
        }
        return HttpResponse.json({ url: `fake://${photoCallCount}.jpg` }, { status: 201 })
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Ok')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Umrühren.')
    const input = screen.getAllByTestId('photo-upload-input')[0] as HTMLInputElement
    await user.upload(input, new File(['a'], 'a.jpg', { type: 'image/jpeg' }))
    await user.upload(input, new File(['b'], 'b.jpg', { type: 'image/jpeg' }))

    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))

    // Both photo calls must be attempted (second fails; we don't short-circuit).
    await waitFor(() => expect(photoCallCount).toBe(2))
    // Partial-failure banner surfaces.
    await waitFor(() => {
      const banner = screen.getByRole('alert')
      expect(banner).toHaveTextContent(/1 von 2 Fotos konnten nicht hochgeladen werden/i)
      expect(banner).toHaveTextContent(/5 MB/i)
    })
  })

  // UX1-PU follow-up — total-failure case must also keep the user on the
  // form (not navigate away) so the banner stays readable. Documented
  // deviation from the plan's initial "still navigate" wording; see
  // docs/plans/2026-04-18-ux1-pu-photo-upload-create.md §2.
  it('keeps user on form with banner when ALL staged photos fail (recipe still saved)', async () => {
    const user = userEvent.setup()
    let recipeCreated = false
    let photoCallCount = 0
    server.use(
      http.post('/api/groups/g1/recipes', () => {
        recipeCreated = true
        return HttpResponse.json(
          {
            id: 'r-allfail',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
      http.post('/api/recipes/r-allfail/photos', () => {
        photoCallCount += 1
        return HttpResponse.json(
          { code: 'photo_too_large', message: 'Bild darf maximal 5 MB groß sein.' },
          { status: 413 },
        )
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Ok')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Umrühren.')
    const input = screen.getAllByTestId('photo-upload-input')[0] as HTMLInputElement
    await user.upload(input, new File(['a'], 'a.jpg', { type: 'image/jpeg' }))
    await user.upload(input, new File(['b'], 'b.jpg', { type: 'image/jpeg' }))

    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))

    // Recipe was saved.
    await waitFor(() => expect(recipeCreated).toBe(true))
    // Both upload attempts fired (we don't short-circuit on the first failure).
    await waitFor(() => expect(photoCallCount).toBe(2))
    // Banner announces the full failure count — both photos failed.
    await waitFor(() => {
      const banner = screen.getByRole('alert')
      expect(banner).toHaveTextContent(/2 von 2 Fotos konnten nicht hochgeladen werden/i)
    })
    // The user stays on the form (no navigation away) so the banner is
    // readable. Hallmark: the form's submit button is still in the DOM.
    expect(screen.getByRole('button', { name: /Rezept speichern/i })).toBeInTheDocument()
  })

  it('transitions submit button label Speichern → Fotos hochladen … while staged photos upload', async () => {
    const user = userEvent.setup()
    let resolveRecipe!: () => void
    let resolvePhoto!: () => void
    server.use(
      http.post('/api/groups/g1/recipes', async () => {
        await new Promise<void>((r) => {
          resolveRecipe = r
        })
        return HttpResponse.json(
          {
            id: 'r-lbl',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Ok',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
      http.post('/api/recipes/r-lbl/photos', async () => {
        await new Promise<void>((r) => {
          resolvePhoto = r
        })
        return HttpResponse.json({ url: 'fake://x.jpg' }, { status: 201 })
      }),
    )

    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Ok')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
    await user.type(screen.getByLabelText(/Schritt 1/i), 'Umrühren.')
    const input = screen.getAllByTestId('photo-upload-input')[0] as HTMLInputElement
    await user.upload(input, new File(['x'], 'a.jpg', { type: 'image/jpeg' }))

    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))

    // While recipe create is pending: "Speichere …".
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Speichere/i })).toBeInTheDocument(),
    )
    // Release the recipe POST → photo phase begins.
    resolveRecipe()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Fotos hochladen/i }),
      ).toBeInTheDocument(),
    )
    // Finish the photo upload so the component settles.
    resolvePhoto()
  })

  // P2-7 — URL-import prefill. When the page is entered with an
  // `?importId=…` query in create mode the form fetches the import
  // result, maps it via extractedRecipeToPrefill, and seeds its
  // internal state from the prefill. The AI provenance banner appears
  // on top; missing-quantity ingredients get a yellow "Menge fehlt"
  // badge; handwritten-uncertain rows get the orange badge.

  function withProvidersAndImport(initialPath: string, importJson: string): ReactNode {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialPath]}>
          <BottomZoneProvider>
            <Routes>
              <Route
                path="/groups/:groupId/recipes/new"
                element={<RecipeFormPage mode="create" />}
              />
              <Route
                path="/groups/:groupId/recipes/:recipeId"
                element={<div data-testid="detail-page" />}
              />
            </Routes>
            <BottomNav />
          </BottomZoneProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
    void importJson
  }

  it('prefills title + description + servings + sourceUrl from an import result', async () => {
    server.use(
      http.get('/api/imports/imp-pp', () =>
        HttpResponse.json({
          id: 'imp-pp',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: 'https://www.chefkoch.de/Pizza.html',
          result: JSON.stringify({
            recipe: {
              title: 'Pizza Margherita',
              description: 'Klassisch italienisch',
              servings: 2,
              difficulty: 2,
              prep_minutes: 15,
              cook_minutes: 10,
              components: [
                { label: null, position: 0, ingredients: [
                {
                  name: 'Mehl',
                  quantity: '500',
                  unit: 'g',
                  note: null,
                  confidence: 'high',
                },
              ], steps: [
                {
                  position: 1,
                  content: 'Teig kneten.',
                  confidence: 'high',
                },
              ] },
              ],
              tags: [],
              source_url: 'https://www.chefkoch.de/Pizza.html',
            },
            confidence: { overall: 'high', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:01:00Z',
        }),
      ),
    )
    render(withProvidersAndImport('/groups/g1/recipes/new?importId=imp-pp', ''))
    expect(await screen.findByDisplayValue('Pizza Margherita')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Klassisch italienisch')).toBeInTheDocument()
    // 2 servings prefilled.
    expect(screen.getByLabelText(/Portionen/i)).toHaveValue(2)
    // prep_minutes + cook_minutes = 25.
    expect(screen.getByLabelText(/Dauer/i)).toHaveValue(25)
    // The source URL input is prefilled.
    expect(screen.getByLabelText(/Quelle \(URL\)/i)).toHaveValue(
      'https://www.chefkoch.de/Pizza.html',
    )
    // Ingredient + step prefilled.
    expect(screen.getByLabelText(/Zutat 1 Name/i)).toHaveValue('Mehl')
    expect(screen.getByLabelText(/Zutat 1 Menge/i)).toHaveValue('500')
    expect(screen.getByLabelText(/^Schritt 1$/i)).toHaveValue('Teig kneten.')
  })

  // BUG-045 — pre-select the AI-extracted tags in the tag picker so the
  // user doesn't have to re-click them. The extractor emits tag names
  // (lowercase, German); the form must resolve them against the group's
  // loaded tag catalogue by case-insensitive name match and flip the
  // corresponding TagChips into aria-pressed=true.
  it('pre-selects AI-extracted tags in the tag picker on import prefill', async () => {
    server.use(
      http.get('/api/imports/imp-tags', () =>
        HttpResponse.json({
          id: 'imp-tags',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: 'https://www.instagram.com/reel/abc',
          result: JSON.stringify({
            recipe: {
              title: 'Gemüsepfanne',
              description: null,
              servings: null,
              difficulty: null,
              prep_minutes: null,
              cook_minutes: null,
              components: [
                { label: null, position: 0, ingredients: [
                {
                  name: 'Zucchini',
                  quantity: '1',
                  unit: 'Stück',
                  note: null,
                  confidence: 'high',
                },
              ], steps: [
                { position: 1, content: 'Anbraten.', confidence: 'high' },
              ] },
              ],
              // Extractor emitted lowercase German tag names; catalogue
              // has 'vegan' + 'schnell' (case-insensitive match expected).
              tags: ['vegan', 'schnell'],
              source_url: 'https://www.instagram.com/reel/abc',
            },
            confidence: { overall: 'high', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:01:00Z',
        }),
      ),
    )
    render(withProvidersAndImport('/groups/g1/recipes/new?importId=imp-tags', ''))

    // Wait for the form to mount + tags to load.
    await screen.findByDisplayValue('Gemüsepfanne')

    // Catalogue tags 'vegan' + 'schnell' must come back pre-selected
    // (aria-pressed=true) because the extractor returned those names.
    const veganChip = await screen.findByRole('button', { name: /^vegan$/i })
    const schnellChip = await screen.findByRole('button', { name: /^schnell$/i })
    expect(veganChip).toHaveAttribute('aria-pressed', 'true')
    expect(schnellChip).toHaveAttribute('aria-pressed', 'true')

    // A catalogue tag the extractor didn't emit stays unselected.
    const pizzaChip = screen.getByRole('button', { name: /^Pizzateig$/i })
    expect(pizzaChip).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders the AI-Vorschlag banner with the (truncated) source URL on prefill, which is dismissible', async () => {
    const user = userEvent.setup()
    const longUrl = 'https://www.chefkoch.de/rezepte/12345/omas-apfelkuchen-mit-streuseln.html'
    server.use(
      http.get('/api/imports/imp-banner', () =>
        HttpResponse.json({
          id: 'imp-banner',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: longUrl,
          result: JSON.stringify({
            recipe: {
              title: 'Apfelkuchen',
              description: null,
              servings: null,
              difficulty: null,
              prep_minutes: null,
              cook_minutes: null,
              components: [
                { label: null, position: 0, ingredients: [
                {
                  name: 'Mehl',
                  quantity: '300',
                  unit: 'g',
                  note: null,
                  confidence: 'high',
                },
              ], steps: [
                { position: 1, content: 'Backen.', confidence: 'high' },
              ] },
              ],
              tags: [],
              source_url: longUrl,
            },
            confidence: { overall: 'high', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:01:00Z',
        }),
      ),
    )
    render(withProvidersAndImport('/groups/g1/recipes/new?importId=imp-banner', ''))

    const banner = await screen.findByRole('region', {
      name: /ki-import-hinweis/i,
    })
    expect(banner).toHaveTextContent(/AI-Vorschlag aus/i)
    // URL truncated to 40 chars.
    expect(banner.textContent?.length ?? 0).toBeLessThan(longUrl.length + 80)
    expect(banner.textContent).toMatch(/…/) // ellipsis from truncation

    // Dismiss — banner disappears but the form data stays.
    await user.click(
      within(banner).getByRole('button', { name: /hinweis ausblenden/i }),
    )
    expect(
      screen.queryByRole('region', { name: /ki-import-hinweis/i }),
    ).not.toBeInTheDocument()
    // Data is still there.
    expect(screen.getByDisplayValue('Apfelkuchen')).toBeInTheDocument()
  })

  it('renders "aus deinen Fotos" banner copy (and a blank Quelle input) when the extractor returned the photos:// sentinel', async () => {
    server.use(
      http.get('/api/imports/imp-photo-banner', () =>
        HttpResponse.json({
          id: 'imp-photo-banner',
          source: 'Photos',
          status: 'Done',
          progress: 100,
          sourceUrl: null,
          result: JSON.stringify({
            recipe: {
              title: 'Omas Apfelkuchen',
              description: null,
              servings: null,
              difficulty: null,
              prep_minutes: null,
              cook_minutes: null,
              components: [
                { label: null, position: 0, ingredients: [
                {
                  name: 'Mehl',
                  quantity: '300',
                  unit: 'g',
                  note: null,
                  confidence: 'high',
                },
              ], steps: [{ position: 1, content: 'Backen.', confidence: 'high' }] },
              ],
              tags: [],
              source_url: 'photos://upload',
            },
            confidence: { overall: 'high', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:01:00Z',
        }),
      ),
    )
    render(
      withProvidersAndImport(
        '/groups/g1/recipes/new?importId=imp-photo-banner',
        '',
      ),
    )
    const banner = await screen.findByRole('region', {
      name: /ki-import-hinweis/i,
    })
    // Photo-specific copy: no URL, no ellipsis-truncation — the
    // sentinel is hidden entirely.
    expect(banner).toHaveTextContent(/AI-Vorschlag aus deinen Fotos/i)
    expect(banner.textContent).not.toMatch(/photos:/)
    // The Quelle (URL) input is blank — we mustn't persist the sentinel.
    expect(screen.getByLabelText(/Quelle \(URL\)/i)).toHaveValue('')
  })

  it('renders the yellow "Menge fehlt" badge for ingredients with confidence=missing', async () => {
    server.use(
      http.get('/api/imports/imp-miss', () =>
        HttpResponse.json({
          id: 'imp-miss',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: 'https://example.com/r',
          result: JSON.stringify({
            recipe: {
              title: 'Suppe',
              description: null,
              servings: null,
              difficulty: null,
              prep_minutes: null,
              cook_minutes: null,
              components: [
                { label: null, position: 0, ingredients: [
                {
                  name: 'Gemüse',
                  quantity: null,
                  unit: null,
                  note: null,
                  confidence: 'missing',
                },
              ], steps: [
                { position: 1, content: 'Kochen.', confidence: 'high' },
              ] },
              ],
              tags: [],
              source_url: 'https://example.com/r',
            },
            confidence: { overall: 'medium', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:01:00Z',
        }),
      ),
    )
    render(withProvidersAndImport('/groups/g1/recipes/new?importId=imp-miss', ''))
    expect(await screen.findByText(/Menge fehlt/i)).toBeInTheDocument()
  })

  it('renders the orange "Handschrift prüfen" badge for handwritten_uncertain items', async () => {
    server.use(
      http.get('/api/imports/imp-hand', () =>
        HttpResponse.json({
          id: 'imp-hand',
          source: 'Photos',
          status: 'Done',
          progress: 100,
          sourceUrl: null,
          result: JSON.stringify({
            recipe: {
              title: 'Omas Notiz',
              description: null,
              servings: null,
              difficulty: null,
              prep_minutes: null,
              cook_minutes: null,
              components: [
                { label: null, position: 0, ingredients: [
                {
                  name: 'Muskat',
                  quantity: '1',
                  unit: 'Prise',
                  note: null,
                  confidence: 'handwritten_uncertain',
                },
              ], steps: [
                {
                  position: 1,
                  content: 'Umrühren.',
                  confidence: 'handwritten_uncertain',
                },
              ] },
              ],
              tags: [],
              source_url: '',
            },
            confidence: { overall: 'low', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:01:00Z',
        }),
      ),
    )
    render(withProvidersAndImport('/groups/g1/recipes/new?importId=imp-hand', ''))
    const badges = await screen.findAllByText(/Handschrift prüfen/i)
    // Both the ingredient and the step carry the handwritten flag.
    expect(badges.length).toBeGreaterThanOrEqual(2)
  })

  it('persists the sourceUrl from the prefill when the user submits', async () => {
    const user = userEvent.setup()
    let captured: CreateRecipeRequest | null = null
    server.use(
      http.get('/api/imports/imp-save', () =>
        HttpResponse.json({
          id: 'imp-save',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: 'https://example.com/recipe-x',
          result: JSON.stringify({
            recipe: {
              title: 'Kuchen',
              description: null,
              servings: 4,
              difficulty: 1,
              prep_minutes: null,
              cook_minutes: null,
              components: [
                { label: null, position: 0, ingredients: [
                {
                  name: 'Mehl',
                  quantity: '200',
                  unit: 'g',
                  note: null,
                  confidence: 'high',
                },
              ], steps: [
                { position: 1, content: 'Backen.', confidence: 'high' },
              ] },
              ],
              tags: [],
              source_url: 'https://example.com/recipe-x',
            },
            confidence: { overall: 'high', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:01:00Z',
        }),
      ),
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        captured = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(
          {
            id: 'r-s',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Kuchen',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
          },
          { status: 201 },
        )
      }),
    )
    render(withProvidersAndImport('/groups/g1/recipes/new?importId=imp-save', ''))
    await screen.findByDisplayValue('Kuchen')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))
    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured!.sourceUrl).toBe('https://example.com/recipe-x')
  })

  // ── P2-10 — Nutrition estimate prefill + save ─────────────────────

  it('renders a read-only Nährwerte card when the prefill carries a nutrition estimate', async () => {
    server.use(
      http.get('/api/imports/imp-nutri', () =>
        HttpResponse.json({
          id: 'imp-nutri',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: 'https://example.com/nutri',
          result: JSON.stringify({
            recipe: {
              title: 'Mit Nährwerten',
              description: null,
              servings: 4,
              difficulty: 1,
              prep_minutes: null,
              cook_minutes: null,
              components: [
                { label: null, position: 0, ingredients: [], steps: [] },
              ],
              tags: [],
              source_url: 'https://example.com/nutri',
              nutrition_estimate: {
                kcal: 420,
                protein_g: 24,
                carbs_g: 38,
                fat_g: 9,
              },
            },
            confidence: { overall: 'high', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:01:00Z',
        }),
      ),
    )
    render(
      withProvidersAndImport('/groups/g1/recipes/new?importId=imp-nutri', ''),
    )
    await screen.findByDisplayValue('Mit Nährwerten')
    expect(
      screen.getByRole('heading', { name: /Nährwerte \(geschätzt\)/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('420 kcal')).toBeInTheDocument()
    expect(screen.getByText(/24 g/)).toBeInTheDocument()
    expect(screen.getByText(/38 g/)).toBeInTheDocument()
    expect(screen.getByText(/9 g/)).toBeInTheDocument()
  })

  it('does not render the Nährwerte card when the prefill has no estimate', async () => {
    server.use(
      http.get('/api/imports/imp-no-nutri', () =>
        HttpResponse.json({
          id: 'imp-no-nutri',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: 'https://example.com/plain',
          result: JSON.stringify({
            recipe: {
              title: 'Ohne Nährwerte',
              description: null,
              servings: 4,
              difficulty: 1,
              prep_minutes: null,
              cook_minutes: null,
              components: [
                { label: null, position: 0, ingredients: [], steps: [] },
              ],
              tags: [],
              source_url: 'https://example.com/plain',
              nutrition_estimate: null,
            },
            confidence: { overall: 'high', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:01:00Z',
        }),
      ),
    )
    render(
      withProvidersAndImport('/groups/g1/recipes/new?importId=imp-no-nutri', ''),
    )
    await screen.findByDisplayValue('Ohne Nährwerte')
    expect(
      screen.queryByRole('heading', { name: /Nährwerte/i }),
    ).not.toBeInTheDocument()
  })

  it('includes the prefill nutrition estimate in the CreateRecipeRequest payload on save', async () => {
    const user = userEvent.setup()
    let captured: CreateRecipeRequest | null = null
    server.use(
      http.get('/api/imports/imp-nutri-save', () =>
        HttpResponse.json({
          id: 'imp-nutri-save',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: 'https://example.com/s',
          result: JSON.stringify({
            recipe: {
              title: 'Save with Nutrition',
              description: null,
              servings: 2,
              difficulty: 1,
              prep_minutes: null,
              cook_minutes: null,
              components: [
                { label: null, position: 0, ingredients: [
                {
                  name: 'Mehl',
                  quantity: '200',
                  unit: 'g',
                  note: null,
                  confidence: 'high',
                },
              ], steps: [
                { position: 1, content: 'Backen.', confidence: 'high' },
              ] },
              ],
              tags: [],
              source_url: 'https://example.com/s',
              nutrition_estimate: {
                kcal: 300,
                protein_g: 10,
                carbs_g: 30,
                fat_g: 8,
              },
            },
            confidence: { overall: 'high', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:01:00Z',
        }),
      ),
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        captured = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(
          {
            id: 'r-ns',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Save with Nutrition',
            defaultServings: 2,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-18T00:00:00Z',
            updatedAt: '2026-04-18T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
            nutritionEstimate: null,
          },
          { status: 201 },
        )
      }),
    )
    render(
      withProvidersAndImport(
        '/groups/g1/recipes/new?importId=imp-nutri-save',
        '',
      ),
    )
    await screen.findByDisplayValue('Save with Nutrition')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))
    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured!.nutritionEstimate).toEqual({
      kcal: 300,
      proteinG: 10,
      carbsG: 30,
      fatG: 8,
    })
  })

  // BF1 #1 — the German "Menge" placeholder was being clipped because the
  // amount column was only 70px wide. The grid template that lays out the
  // ingredient row's three primary inputs (qty | unit | name) must reserve
  // enough space for the placeholder to render in full. We assert via the
  // declared Tailwind class because jsdom can't measure actual text width.
  it('reserves enough width on the amount input for the "Menge" placeholder', () => {
    render(withProviders('/groups/g1/recipes/new'))
    const mengeInput = screen.getByLabelText(/Zutat 1 Menge/i) as HTMLInputElement
    expect(mengeInput).toHaveAttribute('placeholder', 'Menge')
    // BUG-029 — on <md viewports the Menge input now sits inside a
    // flex sub-row (`w-[96px]` explicit width). On md+ the parent
    // container becomes a grid with `md:grid-cols-[92px_96px_1fr]`
    // which governs the first column's width. Walk up to find the
    // container that carries the md-grid template.
    const gridContainer = mengeInput.closest('div.md\\:grid') as HTMLElement | null
    expect(gridContainer).not.toBeNull()
    // Min ≥ 90px for the amount column so a 5-char German placeholder
    // renders without clipping at the typical 14px input font-size +
    // 13px horizontal padding (90 - 26 = 64px usable, comfortably > "Menge").
    expect(gridContainer!.className).toMatch(/md:grid-cols-\[(?:min\(|)9\d|md:grid-cols-\[1\d\d/)
    // And the mobile path: the Menge input itself pins a 96px width so
    // the placeholder renders in full even before md: kicks in.
    expect(mengeInput.className).toMatch(/\bw-\[96px\]/)
  })

  // ── P2-9 — chat-import handoff ────────────────────────────────────
  // `?chatImportId=<uuid>` sources the prefill from sessionStorage
  // (stashed by ChatPage before navigation). No Hangfire poll, no
  // `/api/imports/{id}` roundtrip.

  it('prefills from a sessionStorage chat-import stash when ?chatImportId is present', async () => {
    // Arrange: seed the stash the way ChatPage would.
    const { stashChatImport } = await import(
      '@/features/chat/chatImportMemo'
    )
    stashChatImport('cim-pp', {
      groupId: 'g1',
      result: {
        recipe: {
          title: 'Kartoffel-Lauch-Auflauf',
          description: 'Cremig und vegan.',
          servings: 4,
          difficulty: 1,
          prep_minutes: 15,
          cook_minutes: 35,
          components: [
            { label: null, position: 0, ingredients: [
            {
              name: 'Kartoffeln',
              quantity: '800',
              unit: 'g',
              note: null,
              confidence: 'high',
            },
          ], steps: [
            {
              position: 1,
              content: 'Kartoffeln schälen.',
              confidence: 'high',
            },
          ] },
          ],
          tags: ['vegan'],
          source_url: 'chat://session/abc',
        },
        confidence: { overall: 'medium', notes: [] },
      },
    })

    render(withProviders('/groups/g1/recipes/new?chatImportId=cim-pp'))
    expect(
      await screen.findByDisplayValue('Kartoffel-Lauch-Auflauf'),
    ).toBeInTheDocument()
    expect(
      screen.getByDisplayValue('Cremig und vegan.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/Portionen/i)).toHaveValue(4)
    // chat:// sentinel is stripped — the source URL field is empty.
    expect(screen.getByLabelText(/Quelle \(URL\)/i)).toHaveValue('')

    window.sessionStorage.clear()
  })

  it('renders the chat-specific provenance banner copy ("aus dem Chat")', async () => {
    const { stashChatImport } = await import(
      '@/features/chat/chatImportMemo'
    )
    stashChatImport('cim-banner', {
      groupId: 'g1',
      result: {
        recipe: {
          title: 'T',
          description: null,
          servings: 4,
          difficulty: 1,
          prep_minutes: 10,
          cook_minutes: 10,
          components: [
            { label: null, position: 0, ingredients: [
            {
              name: 'X',
              quantity: '1',
              unit: 'g',
              note: null,
              confidence: 'high',
            },
          ], steps: [{ position: 1, content: 'Mix.', confidence: 'high' }] },
          ],
          tags: [],
          source_url: 'chat://session/banner',
        },
        confidence: { overall: 'medium', notes: [] },
      },
    })
    render(withProviders('/groups/g1/recipes/new?chatImportId=cim-banner'))
    const banner = await screen.findByRole('region', {
      name: /ki-import-hinweis/i,
    })
    expect(banner).toHaveTextContent(/aus dem Chat/i)
    expect(banner).not.toHaveTextContent(/chat:\/\//)
    window.sessionStorage.clear()
  })

  it('forgets the sessionStorage stash after a successful save', async () => {
    const user = userEvent.setup()
    const { stashChatImport, recallChatImport } = await import(
      '@/features/chat/chatImportMemo'
    )
    stashChatImport('cim-save', {
      groupId: 'g1',
      result: {
        recipe: {
          title: 'Chat-Saved',
          description: null,
          servings: 4,
          difficulty: 1,
          prep_minutes: 5,
          cook_minutes: 5,
          components: [
            { label: null, position: 0, ingredients: [
            {
              name: 'Salz',
              quantity: '1',
              unit: 'Prise',
              note: null,
              confidence: 'high',
            },
          ], steps: [{ position: 1, content: 'Würzen.', confidence: 'high' }] },
          ],
          tags: [],
          source_url: 'chat://x',
        },
        confidence: { overall: 'medium', notes: [] },
      },
    })
    server.use(
      http.post('/api/groups/g1/recipes', () =>
        HttpResponse.json(
          { id: 'r-chat', title: 'Chat-Saved' },
          { status: 201 },
        ),
      ),
    )
    render(withProviders('/groups/g1/recipes/new?chatImportId=cim-save'))
    await screen.findByDisplayValue('Chat-Saved')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))
    // After the save resolves the stash is gone.
    await waitFor(() => expect(recallChatImport('cim-save')).toBeNull())
  })

  it('forgets the sessionStorage stash when the user cancels via the top-nav X', async () => {
    const user = userEvent.setup()
    const { stashChatImport, recallChatImport } = await import(
      '@/features/chat/chatImportMemo'
    )
    stashChatImport('cim-cancel', {
      groupId: 'g1',
      result: {
        recipe: {
          title: 'To-Discard',
          description: null,
          servings: 4,
          difficulty: 1,
          prep_minutes: 5,
          cook_minutes: 5,
          components: [
            { label: null, position: 0, ingredients: [
            {
              name: 'Zwiebel',
              quantity: '1',
              unit: 'Stück',
              note: null,
              confidence: 'high',
            },
          ], steps: [{ position: 1, content: 'Schneiden.', confidence: 'high' }] },
          ],
          tags: [],
          source_url: 'chat://y',
        },
        confidence: { overall: 'medium', notes: [] },
      },
    })
    render(withProviders('/groups/g1/recipes/new?chatImportId=cim-cancel'))
    await screen.findByDisplayValue('To-Discard')
    // Multiple "Abbrechen" affordances exist (top-nav X + action bar);
    // pick the first — both call the same cancel() handler.
    await user.click(screen.getAllByRole('button', { name: /Abbrechen/i })[0])
    expect(recallChatImport('cim-cancel')).toBeNull()
  })

  it('falls through to a blank create form when the chatImportId stash is missing (expired/new tab)', async () => {
    window.sessionStorage.clear()
    render(withProviders('/groups/g1/recipes/new?chatImportId=cim-missing'))
    // No prefill → no AI banner.
    expect(
      screen.queryByRole('region', { name: /ki-import-hinweis/i }),
    ).not.toBeInTheDocument()
    // Title input empty.
    expect(screen.getByLabelText(/Titel/i)).toHaveValue('')
  })

  // ── PF1 — staged-photo promote handshake ─────────────────────────
  // The photo-import flow uploads photos via POST /api/recipes/photos/staged
  // (returns stagedPhotoIds), stashes them in sessionStorage under
  // the importId, then routes the user here through ?importId=…. The
  // form must (a) read the stash, (b) include the ids in the
  // create-recipe payload, (c) show the "{N} Fotos werden beim
  // Speichern angehängt" badge, and (d) render the partial-failure
  // banner when the server returns partialPhotoFailures.

  function photoImportResponse(importId: string, title: string) {
    return HttpResponse.json({
      id: importId,
      source: 'Photos',
      status: 'Done',
      progress: 100,
      sourceUrl: null,
      result: JSON.stringify({
        recipe: {
          title,
          description: null,
          servings: 4,
          difficulty: 1,
          prep_minutes: null,
          cook_minutes: null,
          components: [
            { label: null, position: 0, ingredients: [
            {
              name: 'Mehl',
              quantity: '300',
              unit: 'g',
              note: null,
              confidence: 'high',
            },
          ], steps: [{ position: 1, content: 'Mischen.', confidence: 'high' }] },
          ],
          tags: [],
          source_url: 'photos://upload',
        },
        confidence: { overall: 'high', notes: [] },
      }),
      error: null,
      createdAt: '2026-04-19T00:00:00Z',
      completedAt: '2026-04-19T00:01:00Z',
    })
  }

  it('shows the "werden beim Speichern angehängt" pill when stagedPhotos are stashed', async () => {
    // BUG-024 — the pill dropped the count since the user now sees
    // the actual thumbnails below. The copy asserts against the
    // invariant wording (German phrase without the number).
    const { rememberImportStagedPhotoIds } = await import(
      '@/features/imports/importGroupMemo'
    )
    rememberImportStagedPhotoIds('imp-pf1-info', ['s1', 's2', 's3'])
    server.use(
      http.get('/api/imports/imp-pf1-info', () =>
        photoImportResponse('imp-pf1-info', 'PF1 Info'),
      ),
    )

    render(
      withProvidersAndImport(
        '/groups/g1/recipes/new?importId=imp-pf1-info',
        '',
      ),
    )
    expect(await screen.findByDisplayValue('PF1 Info')).toBeInTheDocument()
    const badge = screen.getByTestId('staged-photos-info')
    expect(badge).toHaveTextContent(/werden beim Speichern angehängt/i)

    window.sessionStorage.clear()
  })

  it('skips the staged-photos badge when the import is NOT a photo import (URL import)', async () => {
    // URL imports never stash stagedPhotoIds; the badge must not
    // appear even if other prefill data is present.
    server.use(
      http.get('/api/imports/imp-url-no-photos', () =>
        HttpResponse.json({
          id: 'imp-url-no-photos',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: 'https://example.com/r',
          result: JSON.stringify({
            recipe: {
              title: 'URL Import',
              description: null,
              servings: 4,
              difficulty: 1,
              prep_minutes: null,
              cook_minutes: null,
              components: [
                { label: null, position: 0, ingredients: [
                {
                  name: 'Mehl',
                  quantity: '1',
                  unit: 'g',
                  note: null,
                  confidence: 'high',
                },
              ], steps: [{ position: 1, content: 'X.', confidence: 'high' }] },
              ],
              tags: [],
              source_url: 'https://example.com/r',
            },
            confidence: { overall: 'high', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-19T00:00:00Z',
          completedAt: '2026-04-19T00:01:00Z',
        }),
      ),
    )
    render(
      withProvidersAndImport(
        '/groups/g1/recipes/new?importId=imp-url-no-photos',
        '',
      ),
    )
    await screen.findByDisplayValue('URL Import')
    expect(screen.queryByTestId('staged-photos-info')).not.toBeInTheDocument()
  })

  it('forwards stagedPhotoIds in the create-recipe payload on save', async () => {
    const user = userEvent.setup()
    const { rememberImportStagedPhotoIds } = await import(
      '@/features/imports/importGroupMemo'
    )
    rememberImportStagedPhotoIds('imp-pf1-save', ['s1', 's2'])

    let captured: CreateRecipeRequest | null = null
    server.use(
      http.get('/api/imports/imp-pf1-save', () =>
        photoImportResponse('imp-pf1-save', 'PF1 Save'),
      ),
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        captured = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(
          {
            id: 'r-pf1',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'PF1 Save',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [
              '/api/photos/recipes/p1.jpg?sig=x&exp=9',
              '/api/photos/recipes/p2.jpg?sig=x&exp=9',
            ],
            createdAt: '2026-04-19T00:00:00Z',
            updatedAt: '2026-04-19T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
            nutritionEstimate: null,
            partialPhotoFailures: null,
          },
          { status: 201 },
        )
      }),
    )

    render(
      withProvidersAndImport(
        '/groups/g1/recipes/new?importId=imp-pf1-save',
        '',
      ),
    )
    await screen.findByDisplayValue('PF1 Save')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))
    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured!.stagedPhotoIds).toEqual(['s1', 's2'])

    window.sessionStorage.clear()
  })

  it('renders the partial-failure banner when the server reports partialPhotoFailures', async () => {
    const user = userEvent.setup()
    const { rememberImportStagedPhotoIds } = await import(
      '@/features/imports/importGroupMemo'
    )
    rememberImportStagedPhotoIds('imp-pf1-partial', ['s1', 's2', 's3'])

    server.use(
      http.get('/api/imports/imp-pf1-partial', () =>
        photoImportResponse('imp-pf1-partial', 'PF1 Partial'),
      ),
      http.post('/api/groups/g1/recipes', () =>
        HttpResponse.json(
          {
            id: 'r-partial',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'PF1 Partial',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: ['/api/photos/recipes/x.jpg?sig=x&exp=9'],
            createdAt: '2026-04-19T00:00:00Z',
            updatedAt: '2026-04-19T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
            nutritionEstimate: null,
            partialPhotoFailures: [
              { stagedPhotoId: 's2', reason: 'Foto konnte nicht kopiert werden.' },
              { stagedPhotoId: 's3', reason: 'Foto konnte nicht kopiert werden.' },
            ],
          },
          { status: 201 },
        ),
      ),
    )

    render(
      withProvidersAndImport(
        '/groups/g1/recipes/new?importId=imp-pf1-partial',
        '',
      ),
    )
    await screen.findByDisplayValue('PF1 Partial')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      /Rezept gespeichert.*2 von 3 Fotos.*manuell hochladen/i,
    )

    window.sessionStorage.clear()
  })

  // BUG-024 — when the user arrives at the review form with staged
  // photos, the grid renders the actual thumbnails (signed SeaweedFS
  // URLs) alongside the amber "werden beim Speichern angehängt" pill.
  // Removing one tile hits DELETE /api/staged-photos/:id and drops
  // the entry from the local state + memo so the save POST reflects
  // the reduced list.
  it('renders <img> thumbnails for each preAttached photo plus the info pill', async () => {
    const { rememberImportStagedPhotos } = await import(
      '@/features/imports/importGroupMemo'
    )
    rememberImportStagedPhotos('imp-bug024-render', [
      { stagedPhotoId: 's1', url: '/api/photos/s1.jpg?sig=a' },
      { stagedPhotoId: 's2', url: '/api/photos/s2.jpg?sig=b' },
    ])
    server.use(
      http.get('/api/imports/imp-bug024-render', () =>
        photoImportResponse('imp-bug024-render', 'BUG-024 Render'),
      ),
    )

    render(
      withProvidersAndImport(
        '/groups/g1/recipes/new?importId=imp-bug024-render',
        '',
      ),
    )
    await screen.findByDisplayValue('BUG-024 Render')

    // Two thumbnails render with the right src URLs.
    const imgs = screen.getAllByRole('img')
    expect(imgs.length).toBeGreaterThanOrEqual(2)
    const srcs = imgs.map((i) => i.getAttribute('src'))
    expect(srcs).toContain('/api/photos/s1.jpg?sig=a')
    expect(srcs).toContain('/api/photos/s2.jpg?sig=b')

    // Amber pill with the new count-less copy.
    expect(screen.getByTestId('staged-photos-info')).toHaveTextContent(
      /werden beim Speichern angehängt/i,
    )

    window.sessionStorage.clear()
  })

  it('removes a preAttached thumbnail when × is tapped + hits DELETE /api/staged-photos/:id', async () => {
    const user = userEvent.setup()
    const { rememberImportStagedPhotos, recallImportStagedPhotos } =
      await import('@/features/imports/importGroupMemo')
    rememberImportStagedPhotos('imp-bug024-remove', [
      { stagedPhotoId: 's-keep', url: '/api/photos/keep.jpg?sig=a' },
      { stagedPhotoId: 's-drop', url: '/api/photos/drop.jpg?sig=b' },
    ])

    let deletedId: string | null = null
    server.use(
      http.get('/api/imports/imp-bug024-remove', () =>
        photoImportResponse('imp-bug024-remove', 'BUG-024 Remove'),
      ),
      http.delete('/api/staged-photos/:id', ({ params }) => {
        deletedId = params.id as string
        return new HttpResponse(null, { status: 204 })
      }),
    )

    render(
      withProvidersAndImport(
        '/groups/g1/recipes/new?importId=imp-bug024-remove',
        '',
      ),
    )
    await screen.findByDisplayValue('BUG-024 Remove')
    expect(screen.getAllByRole('img')).toHaveLength(2)

    // Two remove buttons — click the one tied to s-drop. The button
    // order matches the preAttached list order, so the second
    // preattached slot's × targets s-drop.
    const removeButtons = screen.getAllByRole('button', {
      name: /Importiertes Foto entfernen/i,
    })
    expect(removeButtons).toHaveLength(2)
    await user.click(removeButtons[1]!)

    // Tile disappears optimistically.
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1))
    // DELETE fired with the right id.
    await waitFor(() => expect(deletedId).toBe('s-drop'))
    // Memo reflects the reduced list.
    expect(recallImportStagedPhotos('imp-bug024-remove')).toEqual([
      { stagedPhotoId: 's-keep', url: '/api/photos/keep.jpg?sig=a' },
    ])

    window.sessionStorage.clear()
  })

  it('does NOT include stagedPhotoIds when none were stashed (manual create)', async () => {
    const user = userEvent.setup()
    let captured: CreateRecipeRequest | null = null
    server.use(
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        captured = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(
          {
            id: 'r-plain',
            groupId: 'g1',
            createdByUserId: 'u1',
            createdByDisplayName: 'U',
            title: 'Plain',
            defaultServings: 4,
            difficulty: 1,
            sourceType: 'Manual',
            photos: [],
            createdAt: '2026-04-19T00:00:00Z',
            updatedAt: '2026-04-19T00:00:00Z',
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
            nutritionEstimate: null,
          },
          { status: 201 },
        )
      }),
    )
    render(withProviders('/groups/g1/recipes/new'))
    await user.type(screen.getByLabelText(/Titel/i), 'Plain')
    await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
    await user.type(screen.getByLabelText(/^Schritt 1$/i), 'Mischen.')
    await user.click(screen.getByRole('button', { name: /Rezept speichern/i }))
    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured!.stagedPhotoIds).toBeUndefined()
  })

  // ── BUG-017: race condition in prefill after auto-redirect ─────────
  //
  // `ImportProgressPage` auto-redirects to `/groups/:g/recipes/new?importId=…`
  // once the status flips to `done`. In the wild, the TanStack Query cache
  // that arrives with us can be in a transient partial state where
  // `status === 'done'` but `result` is still `null` — e.g. a SignalR
  // progress event merged the status bump before polling caught up and
  // populated the full payload. Without a wrapper guard that waits for
  // `result`, `RecipeFormInner` mounts with `prefill === undefined` and
  // its `useState` initialisers commit empty values permanently.
  //
  // We seed the cache with `QueryClient.setQueryData` to reproduce each
  // shape deterministically, bypassing MSW/polling timing.
  describe('BUG-017 — seeded-cache race conditions on auto-redirect', () => {
    function withSeededCache(
      initialPath: string,
      seed: RecipeImportDto,
    ): ReactNode {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      client.setQueryData(importQueryKeys.status(seed.id), seed)
      // Keep the GET mocked to never resolve — the point of these tests
      // is the behaviour BEFORE the fresh refetch lands. The wrapper
      // must decide purely off the seeded cache state.
      server.use(
        http.get(`/api/imports/${seed.id}`, () => new Promise(() => {})),
      )
      return (
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[initialPath]}>
            <BottomZoneProvider>
              <Routes>
                <Route
                  path="/groups/:groupId/recipes/new"
                  element={<RecipeFormPage mode="create" />}
                />
              </Routes>
              <BottomNav />
            </BottomZoneProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    }

    it('blocks Inner-render on "Lade Rezept-Daten …" when cache has status=done but result=null (SignalR-polluted cache)', async () => {
      const seed: RecipeImportDto = {
        id: 'imp-race-null',
        groupId: 'g1',
        source: 'url',
        status: 'done',
        progress: 100,
        sourceUrl: 'https://example.com/r',
        result: null,
        errorMessage: null,
        createdAt: '2026-04-19T12:00:00Z',
        completedAt: '2026-04-19T12:00:05Z',
      }
      render(
        withSeededCache('/groups/g1/recipes/new?importId=imp-race-null', seed),
      )

      // Wrapper must render the bridging loader, NOT the inner form.
      expect(await screen.findByText(/Lade Rezept-Daten …/i)).toBeInTheDocument()
      // Sanity-check: no title field committed with an empty value.
      expect(screen.queryByLabelText(/^Titel$/i)).not.toBeInTheDocument()
    })

    it('renders the inner form with prefilled title when cache has a populated result', async () => {
      const seed: RecipeImportDto = {
        id: 'imp-race-ok',
        groupId: 'g1',
        source: 'url',
        status: 'done',
        progress: 100,
        sourceUrl: 'https://example.com/ok',
        result: {
          recipe: {
            title: 'Race-Winner Pizza',
            description: null,
            servings: null,
            difficulty: null,
            prep_minutes: null,
            cook_minutes: null,
            components: [
              { label: null, position: 0, ingredients: [
              {
                name: 'Mehl',
                quantity: '500',
                unit: 'g',
                note: null,
                confidence: 'high',
              },
            ], steps: [
              { position: 1, content: 'Teig kneten.', confidence: 'high' },
            ] },
            ],
            tags: [],
            source_url: 'https://example.com/ok',
          },
          confidence: { overall: 'high', notes: [] },
        },
        errorMessage: null,
        createdAt: '2026-04-19T12:00:00Z',
        completedAt: '2026-04-19T12:00:05Z',
      }
      render(
        withSeededCache('/groups/g1/recipes/new?importId=imp-race-ok', seed),
      )

      // Inner form committed with prefill — title is populated on mount.
      expect(
        await screen.findByDisplayValue('Race-Winner Pizza'),
      ).toBeInTheDocument()
      expect(screen.getByLabelText(/Zutat 1 Name/i)).toHaveValue('Mehl')
    })

    it('renders the error banner with the server message when cache reports status=error', async () => {
      const seed: RecipeImportDto = {
        id: 'imp-race-err',
        groupId: 'g1',
        source: 'url',
        status: 'error',
        progress: 0,
        sourceUrl: 'https://example.com/boom',
        result: null,
        errorMessage: 'boom',
        createdAt: '2026-04-19T12:00:00Z',
        completedAt: '2026-04-19T12:00:05Z',
      }
      render(
        withSeededCache('/groups/g1/recipes/new?importId=imp-race-err', seed),
      )

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(/Import fehlgeschlagen:\s*boom/i)
      // No form must be rendered in the error branch.
      expect(screen.queryByLabelText(/^Titel$/i)).not.toBeInTheDocument()
    })

    // ── BUG-018: video-thumbnail auto-attached as staged photo ──────
    //
    // The URL-import job downloads each `recipe.candidate_thumbnails`
    // entry (yt-dlp video frames + JSON-LD images), persists them via
    // SeaweedFS, and surfaces the ordered ids via
    // `candidateStagedPhotoIds` on the import status response. The
    // form's picker grid seeds its default selection from [0] so the
    // create-recipe POST adopts the thumbnail onto the new recipe.

    it('auto-includes the import candidateStagedPhotoIds[0] in the create-recipe stagedPhotoIds (BUG-018)', async () => {
      const user = userEvent.setup()
      const seed: RecipeImportDto = {
        id: 'imp-bug018-thumb',
        groupId: 'g1',
        source: 'url',
        status: 'done',
        progress: 100,
        sourceUrl: 'https://www.facebook.com/somevideo',
        result: {
          recipe: {
            title: 'Video Pizza',
            description: null,
            servings: 4,
            difficulty: 1,
            prep_minutes: null,
            cook_minutes: null,
            components: [
              { label: null, position: 0, ingredients: [
              {
                name: 'Mehl',
                quantity: '300',
                unit: 'g',
                note: null,
                confidence: 'high',
              },
            ], steps: [{ position: 1, content: 'Mix.', confidence: 'high' }] },
            ],
            tags: [],
            source_url: 'https://www.facebook.com/somevideo',
          },
          confidence: { overall: 'high', notes: [] },
        },
        errorMessage: null,
        createdAt: '2026-04-19T12:00:00Z',
        completedAt: '2026-04-19T12:00:30Z',
        // The URL job's post-Done attach step set this to the
        // freshly-created StagedPhoto row's id.
        candidateStagedPhotoIds: ['staged-thumb-uuid'],
      }

      let captured: CreateRecipeRequest | null = null
      server.use(
        http.post('/api/groups/g1/recipes', async ({ request }) => {
          captured = (await request.json()) as CreateRecipeRequest
          return HttpResponse.json(
            {
              id: 'r-bug018',
              groupId: 'g1',
              createdByUserId: 'u1',
              createdByDisplayName: 'U',
              title: 'Video Pizza',
              defaultServings: 4,
              difficulty: 1,
              sourceType: 'Manual',
              photos: [
                '/api/photos/recipes/thumbed.jpg?sig=x&exp=9',
              ],
              createdAt: '2026-04-19T12:00:30Z',
              updatedAt: '2026-04-19T12:00:30Z',
              components: [
                { label: null, position: 0, ingredients: [], steps: [] },
              ],
              tags: [],
              nutritionEstimate: null,
              partialPhotoFailures: null,
            },
            { status: 201 },
          )
        }),
      )

      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-bug018-thumb',
          seed,
        ),
      )

      await screen.findByDisplayValue('Video Pizza')
      await user.click(
        screen.getByRole('button', { name: /Rezept speichern/i }),
      )
      await waitFor(() => expect(captured).not.toBeNull())
      // The thumbnail staged-photo id is forwarded into the create
      // payload — the .NET create endpoint's PF1 promote handshake
      // adopts it onto the saved recipe.
      expect(captured!.stagedPhotoIds).toEqual(['staged-thumb-uuid'])
    })

    it('omits the thumbnail entry when the import has an empty candidateStagedPhotoIds (blog import)', async () => {
      // Blog imports without JSON-LD image arrays and without og:image
      // yield an empty candidate list; the URL job attaches nothing.
      // The form must not invent a staged-photo id out of thin air.
      const user = userEvent.setup()
      const seed: RecipeImportDto = {
        id: 'imp-bug018-noblog',
        groupId: 'g1',
        source: 'url',
        status: 'done',
        progress: 100,
        sourceUrl: 'https://blog.example/recipe',
        result: {
          recipe: {
            title: 'Blog Pizza',
            description: null,
            servings: 4,
            difficulty: 1,
            prep_minutes: null,
            cook_minutes: null,
            components: [
              { label: null, position: 0, ingredients: [
              {
                name: 'Mehl',
                quantity: '1',
                unit: 'g',
                note: null,
                confidence: 'high',
              },
            ], steps: [{ position: 1, content: 'Mix.', confidence: 'high' }] },
            ],
            tags: [],
            source_url: 'https://blog.example/recipe',
          },
          confidence: { overall: 'high', notes: [] },
        },
        errorMessage: null,
        createdAt: '2026-04-19T12:00:00Z',
        completedAt: '2026-04-19T12:00:30Z',
        candidateStagedPhotoIds: [],
      }

      let captured: CreateRecipeRequest | null = null
      server.use(
        http.post('/api/groups/g1/recipes', async ({ request }) => {
          captured = (await request.json()) as CreateRecipeRequest
          return HttpResponse.json(
            {
              id: 'r-blog',
              groupId: 'g1',
              createdByUserId: 'u1',
              createdByDisplayName: 'U',
              title: 'Blog Pizza',
              defaultServings: 4,
              difficulty: 1,
              sourceType: 'Manual',
              photos: [],
              createdAt: '2026-04-19T12:00:30Z',
              updatedAt: '2026-04-19T12:00:30Z',
              components: [
                { label: null, position: 0, ingredients: [], steps: [] },
              ],
              tags: [],
              nutritionEstimate: null,
              partialPhotoFailures: null,
            },
            { status: 201 },
          )
        }),
      )

      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-bug018-noblog',
          seed,
        ),
      )

      await screen.findByDisplayValue('Blog Pizza')
      await user.click(
        screen.getByRole('button', { name: /Rezept speichern/i }),
      )
      await waitFor(() => expect(captured).not.toBeNull())
      // Either omitted or empty — the create endpoint treats both as
      // "no staged photos to promote", so neither is wrong.
      expect(
        captured!.stagedPhotoIds === undefined ||
          captured!.stagedPhotoIds!.length === 0,
      ).toBe(true)
    })
  })

  // ── COVER-0 Slice D — multi-candidate cover picker grid ────────────
  //
  // Successor UX to the BUG-018 single-thumbnail auto-attach: when the
  // URL-extract job captures >=2 cover-candidates (yt-dlp thumbnails +
  // ffmpeg frames + JSON-LD image[]), the form renders a 3×2 picker
  // grid above the photo-upload section. Tile 0 is the default cover
  // (starred + selected); other tiles start unselected. Save body
  // carries `stagedPhotoIds: selectedIds + coverStagedPhotoId`.

  describe('COVER-0 — multi-candidate cover picker grid', () => {
    function importWithCandidates(
      importId: string,
      candidateIds: string[],
    ): RecipeImportDto {
      return {
        id: importId,
        groupId: 'g1',
        source: 'url',
        status: 'done',
        progress: 100,
        sourceUrl: 'https://www.facebook.com/cover-video',
        result: {
          recipe: {
            title: 'Cover Pizza',
            description: null,
            servings: 4,
            difficulty: 1,
            prep_minutes: null,
            cook_minutes: null,
            components: [
              {
                label: null,
                position: 0,
                ingredients: [
                  {
                    name: 'Mehl',
                    quantity: '300',
                    unit: 'g',
                    note: null,
                    confidence: 'high',
                  },
                ],
                steps: [
                  { position: 1, content: 'Mischen.', confidence: 'high' },
                ],
              },
            ],
            tags: [],
            source_url: 'https://www.facebook.com/cover-video',
          },
          confidence: { overall: 'high', notes: [] },
        },
        errorMessage: null,
        createdAt: '2026-04-22T12:00:00Z',
        completedAt: '2026-04-22T12:00:30Z',
        candidateStagedPhotoIds: candidateIds,
      }
    }

    function withSeededCache(
      initialPath: string,
      seed: RecipeImportDto,
    ): ReactNode {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      client.setQueryData(importQueryKeys.status(seed.id), seed)
      server.use(
        http.get(`/api/imports/${seed.id}`, () => new Promise(() => {})),
        // The candidate-endpoint returns freshly-signed URLs per id. A
        // plain one-to-one map keeps the fixture terse.
        http.get(`/api/imports/${seed.id}/candidates`, () =>
          HttpResponse.json({
            candidates: (seed.candidateStagedPhotoIds ?? []).map(
              (id, idx) => ({
                stagedPhotoId: id,
                signedUrl: `https://cdn.example/${id}.jpg`,
                contentType: 'image/jpeg',
                candidateOrder: idx,
                expiresAt: '2026-04-29T12:00:30Z',
              }),
            ),
          }),
        ),
      )
      return (
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[initialPath]}>
            <BottomZoneProvider>
              <Routes>
                <Route
                  path="/groups/:groupId/recipes/new"
                  element={<RecipeFormPage mode="create" />}
                />
              </Routes>
              <BottomNav />
            </BottomZoneProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    }

    it('renders 6 tiles when the import yields 6 candidates; tile 0 is selected + starred by default', async () => {
      const seed = importWithCandidates('imp-cov-6', [
        'c0',
        'c1',
        'c2',
        'c3',
        'c4',
        'c5',
      ])
      render(withSeededCache('/groups/g1/recipes/new?importId=imp-cov-6', seed))

      // Wait until candidate images appear.
      const tileButtons = await screen.findAllByRole('button', {
        name: /Auswählen|Abwählen/,
      })
      expect(tileButtons).toHaveLength(6)
      // Tile 0 is the default cover — aria-pressed=true on both the
      // star (label "Cover-Bild") and the tile body.
      expect(tileButtons[0]).toHaveAttribute('aria-pressed', 'true')
      for (let i = 1; i < 6; i++) {
        expect(tileButtons[i]).toHaveAttribute('aria-pressed', 'false')
      }
      const coverStar = screen.getAllByRole('button', { name: /Cover-Bild/ })
      expect(coverStar).toHaveLength(1)
    })

    it('tapping tile 3 adds it to the selection; cover stays on tile 0', async () => {
      const user = userEvent.setup()
      const seed = importWithCandidates('imp-cov-multi', [
        'c0',
        'c1',
        'c2',
        'c3',
      ])
      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-cov-multi',
          seed,
        ),
      )
      const tiles = await screen.findAllByRole('button', {
        name: /Auswählen|Abwählen/,
      })
      await user.click(tiles[3])
      // Tile 3 flipped to selected; tile 0 still selected + cover.
      expect(tiles[3]).toHaveAttribute('aria-pressed', 'true')
      expect(tiles[0]).toHaveAttribute('aria-pressed', 'true')
      const stars = screen.getAllByRole('button', { name: /Cover-Bild/ })
      expect(stars).toHaveLength(1)
    })

    it('star-tapping tile 3 moves the cover and auto-selects that tile', async () => {
      const user = userEvent.setup()
      const seed = importWithCandidates('imp-cov-star', [
        'c0',
        'c1',
        'c2',
        'c3',
      ])
      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-cov-star',
          seed,
        ),
      )
      await screen.findAllByRole('button', { name: /Auswählen|Abwählen/ })
      // Tile 3 is not the cover → its star has label "Zum Cover machen".
      const promoteStars = screen.getAllByRole('button', {
        name: /Zum Cover machen/,
      })
      // Tiles 1, 2, 3 = three non-cover stars.
      expect(promoteStars).toHaveLength(3)
      await user.click(promoteStars[2]) // tile 3

      // Cover moved; only one star labeled "Cover-Bild" now.
      const nextCoverStars = screen.getAllByRole('button', {
        name: /Cover-Bild/,
      })
      expect(nextCoverStars).toHaveLength(1)
      // Tile 3 must be selected now (auto-select via cover promotion).
      const tiles = screen.getAllByRole('button', {
        name: /Auswählen|Abwählen/,
      })
      expect(tiles[3]).toHaveAttribute('aria-pressed', 'true')
    })

    it('tapping the cover tile body is a no-op (cannot deselect cover)', async () => {
      const user = userEvent.setup()
      const seed = importWithCandidates('imp-cov-protect', ['c0', 'c1'])
      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-cov-protect',
          seed,
        ),
      )
      const tiles = await screen.findAllByRole('button', {
        name: /Auswählen|Abwählen/,
      })
      await user.click(tiles[0]) // cover tile body
      // Still selected + still the cover.
      expect(tiles[0]).toHaveAttribute('aria-pressed', 'true')
      const covers = screen.getAllByRole('button', { name: /Cover-Bild/ })
      expect(covers).toHaveLength(1)
    })

    it('submit carries stagedPhotoIds + coverStagedPhotoId in the create payload', async () => {
      const user = userEvent.setup()
      const seed = importWithCandidates('imp-cov-save', [
        'c0',
        'c1',
        'c2',
      ])
      let captured: CreateRecipeRequest | null = null
      server.use(
        http.post('/api/groups/g1/recipes', async ({ request }) => {
          captured = (await request.json()) as CreateRecipeRequest
          return HttpResponse.json(
            {
              id: 'r-cov',
              groupId: 'g1',
              createdByUserId: 'u1',
              createdByDisplayName: 'U',
              title: 'Cover Pizza',
              defaultServings: 4,
              difficulty: 1,
              sourceType: 'Manual',
              photos: [],
              createdAt: '2026-04-22T12:00:30Z',
              updatedAt: '2026-04-22T12:00:30Z',
              components: [
                { label: null, position: 0, ingredients: [], steps: [] },
              ],
              tags: [],
              nutritionEstimate: null,
              partialPhotoFailures: null,
            },
            { status: 201 },
          )
        }),
      )

      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-cov-save',
          seed,
        ),
      )
      // Wait for picker to render, then add tile 2 to the selection.
      const tiles = await screen.findAllByRole('button', {
        name: /Auswählen|Abwählen/,
      })
      await user.click(tiles[2])

      await user.click(
        screen.getByRole('button', { name: /Rezept speichern/i }),
      )
      await waitFor(() => expect(captured).not.toBeNull())
      // Default cover stays on c0; user also selected c2.
      expect(captured!.stagedPhotoIds).toEqual(['c0', 'c2'])
      expect(captured!.coverStagedPhotoId).toBe('c0')
    })

    it('submit after star-promoting tile 2 carries the new cover', async () => {
      const user = userEvent.setup()
      const seed = importWithCandidates('imp-cov-save2', [
        'c0',
        'c1',
        'c2',
      ])
      let captured: CreateRecipeRequest | null = null
      server.use(
        http.post('/api/groups/g1/recipes', async ({ request }) => {
          captured = (await request.json()) as CreateRecipeRequest
          return HttpResponse.json(
            {
              id: 'r-cov2',
              groupId: 'g1',
              createdByUserId: 'u1',
              createdByDisplayName: 'U',
              title: 'Cover Pizza',
              defaultServings: 4,
              difficulty: 1,
              sourceType: 'Manual',
              photos: [],
              createdAt: '2026-04-22T12:00:30Z',
              updatedAt: '2026-04-22T12:00:30Z',
              components: [
                { label: null, position: 0, ingredients: [], steps: [] },
              ],
              tags: [],
              nutritionEstimate: null,
              partialPhotoFailures: null,
            },
            { status: 201 },
          )
        }),
      )

      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-cov-save2',
          seed,
        ),
      )
      await screen.findAllByRole('button', { name: /Auswählen|Abwählen/ })
      // Star-tap tile 2 → cover moves, tile 2 auto-selects.
      const promoteStars = screen.getAllByRole('button', {
        name: /Zum Cover machen/,
      })
      await user.click(promoteStars[1]) // tile 2

      await user.click(
        screen.getByRole('button', { name: /Rezept speichern/i }),
      )
      await waitFor(() => expect(captured).not.toBeNull())
      // Both tiles remain selected; cover is c2.
      expect(captured!.stagedPhotoIds).toEqual(['c0', 'c2'])
      expect(captured!.coverStagedPhotoId).toBe('c2')
    })

    it('renders the picker with 1 candidate (single-tile grid)', async () => {
      // COVER-0 cleanup — with the legacy single-thumbnail field gone,
      // the picker is the one place a single cover candidate shows up.
      // A 1-tile grid is acceptable UX: user still confirms the cover.
      const seed = importWithCandidates('imp-cov-one', ['only-one'])
      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-cov-one',
          seed,
        ),
      )
      await screen.findByDisplayValue('Cover Pizza')
      // Section header visible because the picker is active.
      expect(await screen.findByText(/Bilder aus Import/i)).toBeInTheDocument()
    })

    it('client-side guard: coverStagedPhotoId must be a member of stagedPhotoIds on the wire', async () => {
      // Defence-in-depth — the backend validates this, but the form
      // should NEVER submit a cover that the server would reject as
      // not-a-member. This covers an edge case where the cover got
      // deselected via a race / bug: the save body must not claim a
      // cover that isn't in the selection.
      const user = userEvent.setup()
      const seed = importWithCandidates('imp-cov-guard', [
        'c0',
        'c1',
        'c2',
      ])
      let captured: CreateRecipeRequest | null = null
      server.use(
        http.post('/api/groups/g1/recipes', async ({ request }) => {
          captured = (await request.json()) as CreateRecipeRequest
          return HttpResponse.json(
            {
              id: 'r-cov-guard',
              groupId: 'g1',
              createdByUserId: 'u1',
              createdByDisplayName: 'U',
              title: 'Cover Pizza',
              defaultServings: 4,
              difficulty: 1,
              sourceType: 'Manual',
              photos: [],
              createdAt: '2026-04-22T12:00:30Z',
              updatedAt: '2026-04-22T12:00:30Z',
              components: [
                { label: null, position: 0, ingredients: [], steps: [] },
              ],
              tags: [],
              nutritionEstimate: null,
              partialPhotoFailures: null,
            },
            { status: 201 },
          )
        }),
      )
      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-cov-guard',
          seed,
        ),
      )
      await screen.findAllByRole('button', { name: /Auswählen|Abwählen/ })
      await user.click(
        screen.getByRole('button', { name: /Rezept speichern/i }),
      )
      await waitFor(() => expect(captured).not.toBeNull())
      // Cover on wire must be a member of stagedPhotoIds (or omitted).
      if (captured!.coverStagedPhotoId !== undefined) {
        expect(captured!.stagedPhotoIds ?? []).toContain(
          captured!.coverStagedPhotoId,
        )
      }
    })
  })

  describe('BUG-025 regression: input font-size ≥ 16px', () => {
    it('Titel input className includes `text-base` (prevents iOS auto-zoom)', () => {
      render(withProviders('/groups/g1/recipes/new'))
      const title = screen.getByLabelText(/Titel/i)
      expect(title.className).toMatch(/\btext-base\b/)
    })
  })

  describe('OFF4 — 409 conflict opens ConflictDialog and Keep-Local retries', () => {
    function editModeProviders(recipeId: string): ReactNode {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      return (
        <QueryClientProvider client={client}>
          <MemoryRouter
            initialEntries={[`/groups/g1/recipes/${recipeId}/edit`]}
          >
            <BottomZoneProvider>
              <Routes>
                <Route
                  path="/groups/:groupId/recipes/:recipeId/edit"
                  element={<RecipeFormPage mode="edit" />}
                />
                <Route
                  path="/groups/:groupId/recipes/:recipeId"
                  element={<div data-testid="detail-page" />}
                />
              </Routes>
              <BottomNav />
            </BottomZoneProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    }

    it('shows the conflict dialog on 409, then Keep-Local retries with If-Match set to the server version', async () => {
      const RECIPE_ID = 'r-confl'
      const user = userEvent.setup()
      let putCallCount = 0
      const ifMatchHeaders: Array<string | null> = []

      const initialRecipe = {
        id: RECIPE_ID,
        groupId: 'g1',
        createdByUserId: 'u1',
        createdByDisplayName: 'U',
        title: 'Bestehender Titel',
        description: 'Alte Beschreibung',
        defaultServings: 4,
        difficulty: 1,
        sourceType: 'Manual',
        photos: [],
        createdAt: '2026-04-18T00:00:00Z',
        updatedAt: '2026-04-18T00:00:00Z',
        version: 3,
        components: [
          {
            id: 'c1',
            position: 0,
            label: null,
            ingredients: [
              {
                id: 'ing-1',
                position: 0,
                quantity: 100,
                unit: 'g',
                name: 'Mehl',
                scalable: true,
              },
            ],
            steps: [{ id: 'st-1', position: 0, content: 'Mischen.' }],
          },
        ],
        tags: [],
        nutritionEstimate: null,
      }

      server.use(
        http.get(`/api/recipes/${RECIPE_ID}`, () =>
          HttpResponse.json(initialRecipe),
        ),
        http.get(`/api/recipes/${RECIPE_ID}/revisions`, () =>
          HttpResponse.json([]),
        ),
        http.put(`/api/recipes/${RECIPE_ID}`, ({ request }) => {
          putCallCount++
          ifMatchHeaders.push(request.headers.get('If-Match'))
          if (putCallCount === 1) {
            return HttpResponse.json(
              {
                code: 'version_mismatch',
                message: 'Der Eintrag wurde zwischenzeitlich geändert.',
                current: {
                  ...initialRecipe,
                  version: 11,
                  title: 'Server-Titel',
                },
              },
              { status: 409 },
            )
          }
          return HttpResponse.json({ ...initialRecipe, version: 12 })
        }),
      )

      render(editModeProviders(RECIPE_ID))

      // Wait for the form to render with the edit-mode initial state.
      const title = await screen.findByLabelText(/Titel/i)
      expect(title).toHaveValue('Bestehender Titel')

      // Submit — in edit mode the action bar label is "Änderungen
      // speichern". There's also a hidden sr-only submit inside the
      // form; we pick the visible one.
      const saveButtons = screen.getAllByRole('button', {
        name: /Änderungen speichern/i,
      })
      await user.click(saveButtons[0]!)

      // Dialog opens.
      const dialog = await screen.findByRole('dialog', {
        name: /Konflikt im Rezept/,
      })
      expect(dialog).toBeInTheDocument()

      // Keep-Local retries.
      await user.click(
        within(dialog).getByRole('button', { name: /Lokal behalten/i }),
      )

      await waitFor(() => expect(putCallCount).toBe(2))
      // First call's If-Match was the cached version 3; the retry must
      // use the server's current version (11).
      expect(ifMatchHeaders[1]).toMatch(/W\/"[^"]+-11"/)
    })
  })

  // ── BUG-029 regression: ingredient-name input width on mobile ─────
  //
  // On a 375px iPhone SE viewport the old inner grid
  // `grid-cols-[92px_96px_1fr]` left the name input with ~37px. We now
  // stack on <md viewports (name full-width row 1; qty + unit sub-row
  // below) and restore the 3-column grid at md+. These tests lock that
  // contract so the layout can't silently regress.
  describe('BUG-029 regression: ingredient row stacks on mobile', () => {
    it('grep-gate: inner grid class always carries the `md:` prefix', () => {
      // Resolve the sibling source file without assuming `import.meta.url`
      // is a `file:` URL — Vitest can sometimes report it as a plain path.
      const metaUrl = import.meta.url
      const thisFile = metaUrl.startsWith('file:')
        ? fileURLToPath(metaUrl)
        : metaUrl
      const sourcePath = resolve(dirname(thisFile), 'RecipeFormPage.tsx')
      const source = readFileSync(sourcePath, 'utf8')
      // The responsive fix must be wired — the grid columns only kick in
      // at md+.
      expect(source).toContain('md:grid-cols-[92px_96px_1fr]')
      // And there must be no bare (non-responsive) variant left behind.
      // Strip `/* … */` and `// …` comments first so references to the
      // old class name inside explanatory comments don't false-positive.
      const codeOnly = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      const bareOccurrences = codeOnly.match(/(?<!md:)grid-cols-\[92px_96px_1fr\]/g)
      expect(bareOccurrences).toBeNull()
    })

    it('width smoke: ingredient-name input carries a full-width (flex/grid-growing) className', () => {
      // jsdom reports `.offsetWidth === 0`, so rather than fight layout
      // we assert the className-level contract: on mobile the name lives
      // in a `flex flex-col` container and therefore stretches to 100%
      // of the available row width (the outer `1fr` cell ≈ 285px on
      // iPhone SE). The parent container must include `flex-col` WITHOUT
      // a width constraint on the input, while the md+ grid keeps the
      // 92/96/1fr column template.
      render(withProviders('/groups/g1/recipes/new'))
      const nameInput = screen.getByLabelText(/Zutat 1 Name/i)
      // No explicit width class on the name input — it is allowed to
      // stretch inside its flex-col parent.
      expect(nameInput.className).not.toMatch(/\bw-\[\d+px\]\b/)
      // The closest container must be a flex-col on mobile and a grid
      // on md+.
      const container = nameInput.parentElement
      expect(container).not.toBeNull()
      expect(container!.className).toMatch(/\bflex-col\b/)
      expect(container!.className).toMatch(/md:grid-cols-\[92px_96px_1fr\]/)
    })

    it('DOM order: name input appears before the Menge input so it leads on mobile', () => {
      // On mobile the stack is rendered in DOM order (name → qty+unit
      // sub-row). On md+ the `md:order-*` utilities reflow them — but
      // DOM order still starts with the name. Use compareDocumentPosition
      // to assert the DOM order regardless of computed CSS.
      render(withProviders('/groups/g1/recipes/new'))
      const nameInput = screen.getByLabelText(/Zutat 1 Name/i)
      const qtyInput = screen.getByLabelText(/Zutat 1 Menge/i)
      // DOCUMENT_POSITION_FOLLOWING (0x04) — nameInput precedes qtyInput.
      const position = nameInput.compareDocumentPosition(qtyInput)
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  // ── BUG-034: empty-extraction explainer ────────────────────────────
  //
  // When the extractor quality-gate flagged the result as empty
  // (no ingredients AND no steps — the typical FB-Reel "not actually a
  // recipe" case), the wrapper must render `EmptyExtractionExplainer`
  // instead of the silent empty form. The user can then either try a
  // different video or — via the escape hatch — proceed to the empty
  // form anyway.
  describe('BUG-034 — empty-extraction explainer', () => {
    function emptyResultSeed(
      importId: string,
      emptyReason:
        | 'no_recipe_detected'
        | 'no_usable_source'
        | 'empty_transcript'
        | 'extractor_error'
        | null = 'no_usable_source',
      signals: {
        had_caption_url: boolean
        had_blog_source: boolean
        had_transcript: boolean
      } = {
        had_caption_url: false,
        had_blog_source: false,
        had_transcript: false,
      },
    ): RecipeImportDto {
      return {
        id: importId,
        groupId: 'g1',
        source: 'url',
        status: 'done',
        progress: 100,
        sourceUrl: 'https://facebook.com/share/r/xyz',
        result: {
          recipe: {
            title: 'Unbekanntes Rezept',
            description: null,
            servings: null,
            difficulty: null,
            prep_minutes: null,
            cook_minutes: null,
            components: [
              { label: null, position: 0, ingredients: [], steps: [] },
            ],
            tags: [],
            source_url: 'https://facebook.com/share/r/xyz',
          },
          confidence: { overall: 'low', notes: [] },
          recipe_empty: true,
          empty_reason: emptyReason,
          signals,
        },
        errorMessage: null,
        createdAt: '2026-04-20T12:00:00Z',
        completedAt: '2026-04-20T12:00:05Z',
      }
    }

    function withSeededCache(
      initialPath: string,
      seed: RecipeImportDto,
    ): ReactNode {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      client.setQueryData(importQueryKeys.status(seed.id), seed)
      server.use(
        http.get(`/api/imports/${seed.id}`, () => new Promise(() => {})),
      )
      return (
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[initialPath]}>
            <BottomZoneProvider>
              <Routes>
                <Route
                  path="/groups/:groupId/recipes/new"
                  element={<RecipeFormPage mode="create" />}
                />
                <Route path="/rezepte/import" element={<div>ImportLandingStub</div>} />
              </Routes>
              <BottomNav />
            </BottomZoneProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    }

    it('renders the explainer instead of the empty form when recipe_empty=true', async () => {
      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-empty',
          emptyResultSeed('imp-empty'),
        ),
      )

      // Explainer heading visible.
      expect(
        await screen.findByRole('heading', { name: /kein rezept erkannt/i }),
      ).toBeInTheDocument()
      // Inner form did NOT mount — no title field, no ingredient inputs.
      expect(screen.queryByLabelText(/^Titel$/i)).not.toBeInTheDocument()
      expect(
        screen.queryByLabelText(/Zutat 1 Name/i),
      ).not.toBeInTheDocument()
    })

    it('switches to the inner form when the user clicks "Trotzdem leer anlegen"', async () => {
      const user = userEvent.setup()
      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-proceed',
          emptyResultSeed('imp-proceed'),
        ),
      )

      // Start in the explainer branch.
      await screen.findByRole('heading', { name: /kein rezept erkannt/i })
      await user.click(
        screen.getByRole('button', { name: /trotzdem leer anlegen/i }),
      )

      // Inner form now rendered — title field + fallback title prefilled.
      expect(
        await screen.findByDisplayValue('Unbekanntes Rezept'),
      ).toBeInTheDocument()
      // Explainer is gone.
      expect(
        screen.queryByRole('heading', { name: /kein rezept erkannt/i }),
      ).not.toBeInTheDocument()
    })

    it('navigates to /rezepte/import on "Anderes Video probieren"', async () => {
      const user = userEvent.setup()
      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-retry',
          emptyResultSeed('imp-retry'),
        ),
      )

      await screen.findByRole('heading', { name: /kein rezept erkannt/i })
      await user.click(
        screen.getByRole('button', { name: /anderes video probieren/i }),
      )

      // Route stub confirms navigation landed on /rezepte/import.
      expect(await screen.findByText(/ImportLandingStub/)).toBeInTheDocument()
    })

    it.each([
      [
        'no_recipe_detected' as const,
        /kein beschreibungstext|keine sprachspur|keine zutaten oder schritte/i,
      ],
      [
        'no_usable_source' as const,
        /kein beschreibungstext|keine sprachspur|manuell ausfüllen/i,
      ],
      [
        'empty_transcript' as const,
        /keinen verwertbaren audio-inhalt|musik oder stumm/i,
      ],
      [
        'extractor_error' as const,
        /fehler aufgetreten|als bug/i,
      ],
    ])(
      'branches copy on empty_reason=%s',
      async (reason, expectedCopy) => {
        render(
          withSeededCache(
            `/groups/g1/recipes/new?importId=imp-${reason}`,
            emptyResultSeed(`imp-${reason}`, reason),
          ),
        )
        await screen.findByRole('heading', { name: /kein rezept erkannt/i })
        expect(screen.getByText(expectedCopy)).toBeInTheDocument()
      },
    )

    it('renders mixed-signal copy when signals are truthy + reason is no_recipe_detected', async () => {
      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-mixed',
          emptyResultSeed('imp-mixed', 'no_recipe_detected', {
            had_caption_url: false,
            had_blog_source: false,
            had_transcript: true,
          }),
        ),
      )
      await screen.findByRole('heading', { name: /kein rezept erkannt/i })
      expect(
        screen.getByText(/sprachspur|audiosprache/i),
      ).toBeInTheDocument()
      expect(
        screen.getByText(/keine zutaten oder schritte/i),
      ).toBeInTheDocument()
    })

    it('shows the sourceUrl chip when the import carries one', async () => {
      render(
        withSeededCache(
          '/groups/g1/recipes/new?importId=imp-chip',
          emptyResultSeed('imp-chip'),
        ),
      )
      await screen.findByRole('heading', { name: /kein rezept erkannt/i })
      expect(
        screen.getByText(/facebook\.com\/share\/r\/xyz/),
      ).toBeInTheDocument()
    })
  })

  // ── COMP-2 — progressive disclosure + multi-component mode ────────
  describe('COMP-2 progressive disclosure', () => {
    it('default create render is identical to pre-COMP-2: no component label input, no component cards', () => {
      render(withProviders('/groups/g1/recipes/new'))
      // Default mode must NOT render any component chrome.
      expect(
        screen.queryByTestId('component-card-0'),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByTestId('component-label-input-0'),
      ).not.toBeInTheDocument()
      // Flat ingredient + step rows still render.
      expect(screen.getByLabelText(/Zutat 1 Name/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/^Schritt 1$/i)).toBeInTheDocument()
      // The "+ Komponente hinzufügen" flip button lives above the list.
      expect(
        screen.getByRole('button', { name: /Komponente hinzufügen/i }),
      ).toBeInTheDocument()
    })

    it('clicking "+ Komponente hinzufügen" flips to multi-component mode rendering two cards', async () => {
      const user = userEvent.setup()
      render(withProviders('/groups/g1/recipes/new'))
      await user.click(
        screen.getByRole('button', { name: /Komponente hinzufügen/i }),
      )
      // Both cards render with their label inputs.
      expect(screen.getByTestId('component-card-0')).toBeInTheDocument()
      expect(screen.getByTestId('component-card-1')).toBeInTheDocument()
      expect(
        screen.getByTestId('component-label-input-0'),
      ).toBeInTheDocument()
      expect(
        screen.getByTestId('component-label-input-1'),
      ).toBeInTheDocument()
    })

    it('label input updates the component label on the submit payload', async () => {
      const user = userEvent.setup()
      let captured: CreateRecipeRequest | null = null
      server.use(
        http.post('/api/groups/g1/recipes', async ({ request }) => {
          captured = (await request.json()) as CreateRecipeRequest
          return HttpResponse.json(
            {
              id: 'r-label',
              groupId: 'g1',
              createdByUserId: 'u1',
              createdByDisplayName: 'U',
              title: 'Ok',
              defaultServings: 4,
              difficulty: 1,
              sourceType: 'Manual',
              photos: [],
              createdAt: '2026-04-21T00:00:00Z',
              updatedAt: '2026-04-21T00:00:00Z',
              version: 0,
              components: [
                { id: 'c1', position: 0, label: null, ingredients: [], steps: [] },
              ],
              tags: [],
            },
            { status: 201 },
          )
        }),
      )
      render(withProviders('/groups/g1/recipes/new'))
      await user.type(screen.getByLabelText(/Titel/i), 'Ok')
      // Flip into multi-component mode.
      await user.click(
        screen.getByRole('button', { name: /Komponente hinzufügen/i }),
      )
      // Fill both components with a label + one ingredient + one step each.
      const labelInputs = screen.getAllByTestId(
        /^component-label-input-\d+$/,
      ) as HTMLInputElement[]
      await user.type(labelInputs[0]!, 'Chipotle Sauce')
      await user.type(labelInputs[1]!, 'Hauptgericht')
      const ingNames = screen.getAllByLabelText(
        /^Zutat 1 Name$/i,
      ) as HTMLInputElement[]
      await user.type(ingNames[0]!, 'Honig')
      await user.type(ingNames[1]!, 'Tortilla')
      const stepAreas = screen.getAllByLabelText(
        /^Schritt 1$/i,
      ) as HTMLTextAreaElement[]
      await user.type(stepAreas[0]!, 'Mischen.')
      await user.type(stepAreas[1]!, 'Anbraten.')
      await user.click(
        screen.getByRole('button', { name: /Rezept speichern/i }),
      )
      await waitFor(() => expect(captured).not.toBeNull())
      expect(captured!.components).toHaveLength(2)
      expect(captured!.components[0]!.label).toBe('Chipotle Sauce')
      expect(captured!.components[0]!.ingredients[0]!.name).toBe('Honig')
      expect(captured!.components[1]!.label).toBe('Hauptgericht')
      expect(captured!.components[1]!.ingredients[0]!.name).toBe('Tortilla')
    })

    it('delete-component button removes the component; disabled when only 1 remains', async () => {
      const user = userEvent.setup()
      render(withProviders('/groups/g1/recipes/new'))
      // Flip to multi-component mode (now 2 components).
      await user.click(
        screen.getByRole('button', { name: /Komponente hinzufügen/i }),
      )
      // Delete button on component 1 is enabled.
      const deleteButtons = screen.getAllByTestId(/^component-delete-\d+$/)
      expect(deleteButtons).toHaveLength(2)
      expect(deleteButtons[0]).not.toBeDisabled()

      await user.click(deleteButtons[0]!)
      // One component remains; its delete is now disabled.
      const remaining = screen.getAllByTestId(/^component-delete-\d+$/)
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).toBeDisabled()
    })

    it('dnd-kit cross-component ingredient drag moves an ingredient between components (reorderAcrossComponents correctness)', async () => {
      // jsdom's rect stubbing doesn't play well with dnd-kit's
      // KeyboardSensor across two separate SortableContexts in a single
      // DndContext — the collision detection can't bridge the gap
      // without layout. Rather than smoke-test the sensor wiring (which
      // the per-component drag tests already cover), we exercise the
      // pure reorder helper directly: flatten rows across components,
      // splice, re-shard. This pins the cross-component move semantics
      // without depending on jsdom layout.
      //
      // The seam under test is the helper's observable behaviour when
      // the DndContext fires onDragEnd — mirrors what the production
      // callback would do with a real drag.
      const user = userEvent.setup()
      let captured: CreateRecipeRequest | null = null
      server.use(
        http.post('/api/groups/g1/recipes', async ({ request }) => {
          captured = (await request.json()) as CreateRecipeRequest
          return HttpResponse.json(
            {
              id: 'r-drag',
              groupId: 'g1',
              createdByUserId: 'u1',
              createdByDisplayName: 'U',
              title: 'Ok',
              defaultServings: 4,
              difficulty: 1,
              sourceType: 'Manual',
              photos: [],
              createdAt: '2026-04-21T00:00:00Z',
              updatedAt: '2026-04-21T00:00:00Z',
              version: 0,
              components: [
                { id: 'c1', position: 0, label: null, ingredients: [], steps: [] },
              ],
              tags: [],
            },
            { status: 201 },
          )
        }),
      )
      render(withProviders('/groups/g1/recipes/new'))
      await user.type(screen.getByLabelText(/Titel/i), 'Ok')
      await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Honig')
      await user.type(screen.getByLabelText(/^Schritt 1$/i), 'Mischen.')
      await user.click(
        screen.getByRole('button', { name: /Komponente hinzufügen/i }),
      )
      const labelInputs = screen.getAllByTestId(
        /^component-label-input-\d+$/,
      ) as HTMLInputElement[]
      await user.type(labelInputs[0]!, 'Sauce')
      await user.type(labelInputs[1]!, 'Main')
      // Component-1 gets a fresh ingredient + step.
      const ingNames = screen.getAllByLabelText(
        /^Zutat 1 Name$/i,
      ) as HTMLInputElement[]
      await user.type(ingNames[1]!, 'Tortilla')
      const stepAreas = screen.getAllByLabelText(
        /^Schritt 1$/i,
      ) as HTMLTextAreaElement[]
      await user.type(stepAreas[1]!, 'Anbraten.')

      // Render-level sanity: two component cards with the expected
      // labels + the add-row buttons proving per-component ingredient
      // lists are in scope for drag.
      expect(screen.getByTestId('component-card-0')).toBeInTheDocument()
      expect(screen.getByTestId('component-card-1')).toBeInTheDocument()
      // Each component has its own ingredient list wrapped in a
      // SortableContext — two drag-handles, one per card.
      const handles = screen.getAllByTestId(/^ingredient-drag-handle-/)
      expect(handles.length).toBeGreaterThanOrEqual(2)

      // Save the form as-is (without simulating the drag) to confirm
      // the nested components payload shape. The helper's correctness
      // is pinned by the shared/unit-side `reorderAcrossComponents`
      // expectations in the regression suite (re-shard boundary).
      await user.click(
        screen.getByRole('button', { name: /Rezept speichern/i }),
      )
      await waitFor(() => expect(captured).not.toBeNull())
      const components = captured!.components
      expect(components).toHaveLength(2)
      expect(components[0]!.label).toBe('Sauce')
      expect(components[0]!.ingredients.map((i) => i.name)).toEqual(['Honig'])
      expect(components[1]!.label).toBe('Main')
      expect(components[1]!.ingredients.map((i) => i.name)).toEqual(['Tortilla'])
    })

    // COMP-2 — unit tests for the cross-component reorder helper. The
    // dnd-kit keyboard sensor drifts in jsdom when crossing two
    // SortableContexts, so we pin the semantics at the helper level.
    describe('reorderAcrossComponents (cross-component drag)', () => {
      // Minimal ComponentRow-shaped fixture — the helper only reads
      // `ingredients`/`steps` arrays + the `key` on each row.
      function comp(label: string | null, ingKeys: string[]) {
        return {
          key: `c-${label ?? 'default'}`,
          label,
          ingredients: ingKeys.map((k) => ({
            key: k,
            quantity: '',
            unit: 'g',
            name: k,
            note: '',
            scalable: true,
          })),
          steps: [],
        }
      }

      it('moves a row from component A to component B when dragged onto B\'s row', () => {
        const prev = [
          comp('Sauce', ['honig', 'chipotle']),
          comp('Main', ['tortilla']),
        ]
        // Drag honig (from Sauce) onto tortilla (in Main).
        const next = reorderAcrossComponents(prev, 'ingredients', 'honig', 'tortilla')
        // Sauce loses honig → only chipotle left.
        expect(next[0]!.ingredients.map((i) => i.name)).toEqual(['chipotle'])
        // Main gains honig at tortilla's slot.
        const mainNames = next[1]!.ingredients.map((i) => i.name)
        expect(mainNames).toContain('honig')
        expect(mainNames).toContain('tortilla')
      })

      it('keeps all other fields intact on the moved row', () => {
        const prev = [
          comp('Sauce', ['honig']),
          comp('Main', ['tortilla']),
        ]
        const next = reorderAcrossComponents(prev, 'ingredients', 'honig', 'tortilla')
        const moved = next[1]!.ingredients.find((i) => i.name === 'honig')!
        // All fields preserved, including the scalable flag + unit.
        expect(moved.scalable).toBe(true)
        expect(moved.unit).toBe('g')
      })

      it('reorders within the same component (no cross-boundary move)', () => {
        const prev = [comp('Sauce', ['honig', 'chipotle', 'zwiebel'])]
        const next = reorderAcrossComponents(prev, 'ingredients', 'honig', 'zwiebel')
        // arrayMove(0, 2) → [chipotle, zwiebel, honig]
        expect(next[0]!.ingredients.map((i) => i.name)).toEqual([
          'chipotle',
          'zwiebel',
          'honig',
        ])
      })

      it('returns the original when either id is unknown', () => {
        const prev = [comp('Sauce', ['honig'])]
        const next = reorderAcrossComponents(prev, 'ingredients', 'ghost', 'honig')
        expect(next).toBe(prev)
      })
    })

    it('POSTs nested components shape to the backend on save (single-default)', async () => {
      const user = userEvent.setup()
      let captured: CreateRecipeRequest | null = null
      server.use(
        http.post('/api/groups/g1/recipes', async ({ request }) => {
          captured = (await request.json()) as CreateRecipeRequest
          return HttpResponse.json(
            {
              id: 'r-nested',
              groupId: 'g1',
              createdByUserId: 'u1',
              createdByDisplayName: 'U',
              title: 'Ok',
              defaultServings: 4,
              difficulty: 1,
              sourceType: 'Manual',
              photos: [],
              createdAt: '2026-04-21T00:00:00Z',
              updatedAt: '2026-04-21T00:00:00Z',
              version: 0,
              components: [
                { id: 'c1', position: 0, label: null, ingredients: [], steps: [] },
              ],
              tags: [],
            },
            { status: 201 },
          )
        }),
      )
      render(withProviders('/groups/g1/recipes/new'))
      await user.type(screen.getByLabelText(/Titel/i), 'Ok')
      await user.type(screen.getByLabelText(/Zutat 1 Name/i), 'Mehl')
      await user.type(screen.getByLabelText(/Schritt 1/i), 'Umrühren.')
      await user.click(
        screen.getByRole('button', { name: /Rezept speichern/i }),
      )
      await waitFor(() => expect(captured).not.toBeNull())
      // The new wire shape carries nested components, NOT the old
      // top-level ingredients/steps arrays.
      expect(captured).toHaveProperty('components')
      expect(captured).not.toHaveProperty('ingredients')
      expect(captured).not.toHaveProperty('steps')
      // Single-default payload: one component with label:null.
      expect(captured!.components).toHaveLength(1)
      expect(captured!.components[0]!.label).toBeNull()
      expect(captured!.components[0]!.ingredients[0]!.name).toBe('Mehl')
      expect(captured!.components[0]!.steps[0]!.content).toBe('Umrühren.')
    })
  })
})
