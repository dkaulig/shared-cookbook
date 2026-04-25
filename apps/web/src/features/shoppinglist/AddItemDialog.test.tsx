import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  AddShoppingListItemRequest,
  ShoppingListItemDto,
} from '@shared-cookbook/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { AddItemDialog } from './AddItemDialog'

const PLAN_ID = '11111111-1111-1111-1111-111111111111'
const LIST_ID = '22222222-2222-2222-2222-222222222222'

function withProviders(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

function responseFor(body: AddShoppingListItemRequest): ShoppingListItemDto {
  return {
    id: 'new-item-id',
    shoppingListId: LIST_ID,
    name: body.name,
    quantity: body.quantity ?? null,
    unit: body.unit ?? null,
    note: body.note ?? null,
    isChecked: false,
    category: body.category ?? 'Sonstiges',
    source: 'Manual',
    sortOrder: 0,
    carriedOverFromPreviousWeek: false,
    createdAt: '2026-04-19T00:00:00Z',
    updatedAt: '2026-04-19T00:00:00Z',
  }
}

function renderDialog(onClose: () => void = () => {}) {
  return render(
    withProviders(
      <AddItemDialog planId={PLAN_ID} listId={LIST_ID} onClose={onClose} />,
    ),
  )
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

describe('<AddItemDialog />', () => {
  it('validates that the name is required', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: /Hinzufügen/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Namen/i)
  })

  it('POSTs name + quantity + unit + note + category and calls onClose on success', async () => {
    let captured: AddShoppingListItemRequest | null = null
    server.use(
      http.post(`/api/shopping-lists/${LIST_ID}/items`, async ({ request }) => {
        captured = (await request.json()) as AddShoppingListItemRequest
        return HttpResponse.json(responseFor(captured), { status: 201 })
      }),
    )

    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog(onClose)

    await user.type(screen.getByLabelText(/^Name$/), 'Avocado')
    await user.type(screen.getByLabelText(/Menge/i), '2')
    await user.type(screen.getByLabelText(/Einheit/i), 'Stk')
    await user.selectOptions(screen.getByLabelText(/Kategorie/i), 'ObstGemuese')
    await user.type(screen.getByLabelText(/Notiz/i), 'reif')
    await user.click(screen.getByRole('button', { name: /Hinzufügen/i }))

    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured).toEqual({
      name: 'Avocado',
      category: 'ObstGemuese',
      quantity: '2',
      unit: 'Stk',
      note: 'reif',
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('omits optional fields when left blank', async () => {
    let captured: AddShoppingListItemRequest | null = null
    server.use(
      http.post(`/api/shopping-lists/${LIST_ID}/items`, async ({ request }) => {
        captured = (await request.json()) as AddShoppingListItemRequest
        return HttpResponse.json(responseFor(captured), { status: 201 })
      }),
    )

    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByLabelText(/^Name$/), 'Salz')
    await user.click(screen.getByRole('button', { name: /Hinzufügen/i }))

    await waitFor(() => expect(captured).not.toBeNull())
    expect(captured).toEqual({ name: 'Salz', category: 'Sonstiges' })
  })

  // REL-3f — backend error-codes route through `classifyMutationError`
  // → localised `errors.json` copy instead of the raw Dev-Message.
  it('shows the localised errors:<code> copy on server failure', async () => {
    server.use(
      http.post(`/api/shopping-lists/${LIST_ID}/items`, () =>
        HttpResponse.json(
          { code: 'invalid_input', message: 'Name too long.', status: 400 },
          { status: 400 },
        ),
      ),
    )

    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByLabelText(/^Name$/), 'Salz')
    await user.click(screen.getByRole('button', { name: /Hinzufügen/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Eingabe ist ungültig\./)
    expect(alert).not.toHaveTextContent(/Name too long/)
  })

  it('calls onClose when "Abbrechen" is clicked', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog(onClose)
    await user.click(screen.getByRole('button', { name: /Abbrechen/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
