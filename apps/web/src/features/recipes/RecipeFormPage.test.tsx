import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
            ingredients: [],
            steps: [],
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
            ingredients: [],
            steps: [],
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
            ingredients: [],
            steps: [],
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
            ingredients: [],
            steps: [],
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
            ingredients: [],
            steps: [],
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
              ingredients: [
                {
                  name: 'Mehl',
                  quantity: '500',
                  unit: 'g',
                  note: null,
                  confidence: 'high',
                },
              ],
              steps: [
                {
                  position: 1,
                  content: 'Teig kneten.',
                  confidence: 'high',
                },
              ],
              tags: [],
              source_url: 'https://www.chefkoch.de/Pizza.html',
              thumbnail_url: null,
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
                { position: 1, content: 'Backen.', confidence: 'high' },
              ],
              tags: [],
              source_url: longUrl,
              thumbnail_url: null,
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
              ingredients: [
                {
                  name: 'Mehl',
                  quantity: '300',
                  unit: 'g',
                  note: null,
                  confidence: 'high',
                },
              ],
              steps: [{ position: 1, content: 'Backen.', confidence: 'high' }],
              tags: [],
              source_url: 'photos://upload',
              thumbnail_url: null,
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
              ingredients: [
                {
                  name: 'Gemüse',
                  quantity: null,
                  unit: null,
                  note: null,
                  confidence: 'missing',
                },
              ],
              steps: [
                { position: 1, content: 'Kochen.', confidence: 'high' },
              ],
              tags: [],
              source_url: 'https://example.com/r',
              thumbnail_url: null,
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
              ingredients: [
                {
                  name: 'Muskat',
                  quantity: '1',
                  unit: 'Prise',
                  note: null,
                  confidence: 'handwritten_uncertain',
                },
              ],
              steps: [
                {
                  position: 1,
                  content: 'Umrühren.',
                  confidence: 'handwritten_uncertain',
                },
              ],
              tags: [],
              source_url: '',
              thumbnail_url: null,
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
              ingredients: [
                {
                  name: 'Mehl',
                  quantity: '200',
                  unit: 'g',
                  note: null,
                  confidence: 'high',
                },
              ],
              steps: [
                { position: 1, content: 'Backen.', confidence: 'high' },
              ],
              tags: [],
              source_url: 'https://example.com/recipe-x',
              thumbnail_url: null,
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
            ingredients: [],
            steps: [],
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

  // BF1 #1 — the German "Menge" placeholder was being clipped because the
  // amount column was only 70px wide. The grid template that lays out the
  // ingredient row's three primary inputs (qty | unit | name) must reserve
  // enough space for the placeholder to render in full. We assert via the
  // declared Tailwind class because jsdom can't measure actual text width.
  it('reserves enough width on the amount input for the "Menge" placeholder', () => {
    render(withProviders('/groups/g1/recipes/new'))
    const mengeInput = screen.getByLabelText(/Zutat 1 Menge/i) as HTMLInputElement
    expect(mengeInput).toHaveAttribute('placeholder', 'Menge')
    // The amount input lives inside a CSS grid whose first column governs
    // its width. Walk up to the grid container and check the template.
    const gridContainer = mengeInput.closest('div.grid') as HTMLElement | null
    expect(gridContainer).not.toBeNull()
    // Min ≥ 90px for the amount column so a 5-char German placeholder
    // renders without clipping at the typical 14px input font-size +
    // 13px horizontal padding (90 - 26 = 64px usable, comfortably > "Menge").
    expect(gridContainer!.className).toMatch(/grid-cols-\[(?:min\(|)9\d|grid-cols-\[1\d\d/)
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
          ingredients: [
            {
              name: 'Kartoffeln',
              quantity: '800',
              unit: 'g',
              note: null,
              confidence: 'high',
            },
          ],
          steps: [
            {
              position: 1,
              content: 'Kartoffeln schälen.',
              confidence: 'high',
            },
          ],
          tags: ['vegan'],
          source_url: 'chat://session/abc',
          thumbnail_url: null,
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
          ingredients: [
            {
              name: 'X',
              quantity: '1',
              unit: 'g',
              note: null,
              confidence: 'high',
            },
          ],
          steps: [{ position: 1, content: 'Mix.', confidence: 'high' }],
          tags: [],
          source_url: 'chat://session/banner',
          thumbnail_url: null,
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
          ingredients: [
            {
              name: 'Salz',
              quantity: '1',
              unit: 'Prise',
              note: null,
              confidence: 'high',
            },
          ],
          steps: [{ position: 1, content: 'Würzen.', confidence: 'high' }],
          tags: [],
          source_url: 'chat://x',
          thumbnail_url: null,
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
          ingredients: [
            {
              name: 'Zwiebel',
              quantity: '1',
              unit: 'Stück',
              note: null,
              confidence: 'high',
            },
          ],
          steps: [{ position: 1, content: 'Schneiden.', confidence: 'high' }],
          tags: [],
          source_url: 'chat://y',
          thumbnail_url: null,
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
})
