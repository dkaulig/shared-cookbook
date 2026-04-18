import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { RecipeFormPage } from './RecipeFormPage'
import type { CreateRecipeRequest } from '@familien-kochbuch/shared'

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
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/groups/:groupId/recipes/new" element={<RecipeFormPage mode="create" />} />
        </Routes>
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
            ingredients: [],
            steps: [],
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
            ingredients: [],
            steps: [],
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
    expect(capturedPayload!.ingredients.map((i) => i.name)).toEqual([
      'Zucker',
      'Mehl',
      'Salz',
    ])
    // Positions must be renumbered 0..n-1 to match the new visual order.
    expect(capturedPayload!.ingredients.map((i) => i.position)).toEqual([0, 1, 2])
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
            ingredients: [],
            steps: [],
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
    expect(capturedPayload!.steps.map((s) => s.content)).toEqual([
      'Zwei',
      'Eins',
      'Drei',
    ])
    expect(capturedPayload!.steps.map((s) => s.position)).toEqual([0, 1, 2])
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
            ingredients: [],
            steps: [],
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
            ingredients: [],
            steps: [],
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
            ingredients: [],
            steps: [],
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
    expect(captured!.ingredients[0]?.quantity).toBeNull()
    expect(captured!.ingredients[0]?.scalable).toBe(false)
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
            ingredients: [],
            steps: [],
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
})
