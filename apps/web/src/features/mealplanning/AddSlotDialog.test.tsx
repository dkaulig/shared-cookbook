import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AddSlotRequest, MealPlanSlotDto } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { AddSlotDialog } from './AddSlotDialog'

const PLAN_ID = '11111111-1111-1111-1111-111111111111'
const RECIPE_ID = '22222222-2222-2222-2222-222222222222'

function withProviders(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

function renderDialog(onClose: () => void = () => {}) {
  return render(
    withProviders(
      <AddSlotDialog
        groupId="g1"
        weekStart="2026-04-20"
        planId={PLAN_ID}
        initialDate="2026-04-21"
        initialMeal="Abend"
        onClose={onClose}
      />,
    ),
  )
}

describe('<AddSlotDialog />', () => {
  it('shows the initial date and meal in the header', () => {
    server.use(
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
    )
    renderDialog()

    expect(screen.getByRole('dialog', { name: /Gericht hinzufügen/i })).toBeInTheDocument()
    expect(screen.getByText(/21\.04\.2026 · Abend/)).toBeInTheDocument()
  })

  it('shows a validation error when neither a recipe nor a label is provided', async () => {
    server.use(
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
    )
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('button', { name: /Hinzufügen/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Rezept oder gib einen Titel/i,
    )
  })

  it('POSTs a slot with a free-text label and calls onClose on success', async () => {
    let captured: AddSlotRequest | null = null
    server.use(
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
      http.post(`/api/mealplans/${PLAN_ID}/slots`, async ({ request }) => {
        captured = (await request.json()) as AddSlotRequest
        const dto: MealPlanSlotDto = {
          id: 'slot-1',
          mealPlanId: PLAN_ID,
          recipeId: null,
          label: captured.label ?? null,
          date: captured.date,
          meal: captured.meal,
          servings: captured.servings,
          sortOrder: 0,
          isCooked: false,
          parentSlotId: null,
          createdAt: '2026-04-21T00:00:00Z',
          updatedAt: '2026-04-21T00:00:00Z',
        }
        return HttpResponse.json(dto, { status: 201 })
      }),
    )

    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog(onClose)

    await user.type(screen.getByLabelText(/Freier Titel/i), 'Reste vom Sonntag')
    const servings = screen.getByLabelText(/Portionen/i)
    await user.clear(servings)
    await user.type(servings, '3')
    await user.click(screen.getByRole('button', { name: /Hinzufügen/i }))

    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured).toEqual({
      recipeId: null,
      label: 'Reste vom Sonntag',
      date: '2026-04-21',
      meal: 'Abend',
      servings: 3,
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('POSTs a slot with the picked recipeId when a search result is selected', async () => {
    let captured: AddSlotRequest | null = null
    server.use(
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({
          items: [
            {
              id: RECIPE_ID,
              groupId: 'g1',
              title: 'Linsencurry',
              description: null,
              photo: null,
              tagIds: [],
              createdByDisplayName: 'U',
              updatedAt: '2026-04-20T00:00:00Z',
              avgRating: null,
              ratingCount: 0,
              myStars: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 8,
        }),
      ),
      http.post(`/api/mealplans/${PLAN_ID}/slots`, async ({ request }) => {
        captured = (await request.json()) as AddSlotRequest
        return HttpResponse.json(
          {
            id: 'slot-1',
            mealPlanId: PLAN_ID,
            recipeId: captured.recipeId ?? null,
            label: null,
            date: captured.date,
            meal: captured.meal,
            servings: captured.servings,
            sortOrder: 0,
            isCooked: false,
            parentSlotId: null,
            createdAt: '2026-04-21T00:00:00Z',
            updatedAt: '2026-04-21T00:00:00Z',
          },
          { status: 201 },
        )
      }),
    )

    const user = userEvent.setup()
    renderDialog()

    await user.type(screen.getByLabelText(/Rezept suchen/i), 'Linsen')
    const pick = await screen.findByRole('button', { name: 'Linsencurry' })
    await user.click(pick)

    await user.click(screen.getByRole('button', { name: /Hinzufügen/i }))

    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured?.recipeId).toBe(RECIPE_ID)
    expect(captured?.label).toBeNull()
  })

  it('surfaces the server error message when the API rejects the slot', async () => {
    server.use(
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
      http.post(`/api/mealplans/${PLAN_ID}/slots`, () =>
        HttpResponse.json(
          { code: 'invalid_input', message: 'Slot-Datum liegt außerhalb der Woche.' },
          { status: 400 },
        ),
      ),
    )

    const user = userEvent.setup()
    renderDialog()

    await user.type(screen.getByLabelText(/Freier Titel/i), 'Reste')
    await user.click(screen.getByRole('button', { name: /Hinzufügen/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Slot-Datum liegt außerhalb der Woche/i,
    )
  })

  it('calls onClose when the user clicks "Abbrechen"', async () => {
    server.use(
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
    )
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderDialog(onClose)

    await user.click(screen.getByRole('button', { name: /Abbrechen/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
