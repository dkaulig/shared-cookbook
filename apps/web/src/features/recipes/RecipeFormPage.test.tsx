import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      ]),
    ),
  )
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
    fireEvent.keyDown(firstHandle, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.keyDown(firstHandle, { key: ' ', code: 'Space' })

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

})
