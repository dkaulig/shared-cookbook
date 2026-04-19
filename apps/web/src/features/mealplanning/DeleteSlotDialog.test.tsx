import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MealPlanSlotDto } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { DeleteSlotDialog } from './DeleteSlotDialog'

const PLAN_ID = '11111111-1111-1111-1111-111111111111'
const SLOT_ID = '22222222-2222-2222-2222-222222222222'

function makeSlot(overrides: Partial<MealPlanSlotDto> = {}): MealPlanSlotDto {
  return {
    id: SLOT_ID,
    mealPlanId: PLAN_ID,
    recipeId: null,
    label: 'Spaghetti',
    date: '2026-04-21',
    meal: 'Abend',
    servings: 2,
    sortOrder: 0,
    isCooked: false,
    parentSlotId: null,
    createdAt: '2026-04-21T10:00:00Z',
    updatedAt: '2026-04-21T10:00:00Z',
    ...overrides,
  }
}

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
      <DeleteSlotDialog
        groupId="g1"
        weekStart="2026-04-20"
        planId={PLAN_ID}
        slot={makeSlot()}
        onClose={onClose}
      />,
    ),
  )
}

describe('<DeleteSlotDialog />', () => {
  it('shows the German confirmation heading', () => {
    renderDialog()
    expect(
      screen.getByRole('heading', { name: /Gericht wirklich löschen\?/i }),
    ).toBeInTheDocument()
  })

  it('issues a DELETE and calls onClose when the user confirms', async () => {
    let calledMethod: string | null = null
    server.use(
      http.delete(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, ({ request }) => {
        calledMethod = request.method
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog(onClose)

    await user.click(screen.getByRole('button', { name: /^Löschen$/i }))

    await waitFor(() => expect(calledMethod).toBe('DELETE'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('does nothing to the server when the user cancels', async () => {
    let calledMethod: string | null = null
    server.use(
      http.delete(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, ({ request }) => {
        calledMethod = request.method
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog(onClose)

    await user.click(screen.getByRole('button', { name: /Abbrechen/i }))
    expect(onClose).toHaveBeenCalled()
    expect(calledMethod).toBeNull()
  })

  it('shows the server error message on 400', async () => {
    server.use(
      http.delete(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, () =>
        HttpResponse.json(
          { code: 'slot.not_found', message: 'Slot wurde nicht gefunden.' },
          { status: 404 },
        ),
      ),
    )

    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole('button', { name: /^Löschen$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Slot wurde nicht gefunden/,
    )
  })
})
