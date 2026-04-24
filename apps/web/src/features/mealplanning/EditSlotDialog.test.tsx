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
import { EditSlotDialog } from './EditSlotDialog'

const PLAN_ID = '11111111-1111-1111-1111-111111111111'
const SLOT_ID = '22222222-2222-2222-2222-222222222222'
const RECIPE_ID = '33333333-3333-3333-3333-333333333333'

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

function renderDialog(slot: MealPlanSlotDto, onClose: () => void = () => {}) {
  return render(
    withProviders(
      <EditSlotDialog
        groupId="g1"
        weekStart="2026-04-20"
        planId={PLAN_ID}
        slot={slot}
        existingSlots={[slot]}
        onClose={onClose}
      />,
    ),
  )
}

describe('<EditSlotDialog />', () => {
  it('prefills the form from the slot DTO', () => {
    server.use(
      http.get('/api/groups/g1/recipes', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
    )

    renderDialog(makeSlot({ label: 'Linsencurry', servings: 4, isCooked: true }))

    expect(screen.getByRole('dialog', { name: /Gericht bearbeiten/i })).toBeInTheDocument()
    expect(screen.getByText(/21\.04\.2026 · Abend/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Freier Titel/i)).toHaveValue('Linsencurry')
    expect(screen.getByLabelText(/Portionen/i)).toHaveValue(4)
    expect(screen.getByLabelText(/^Gekocht$/i)).toBeChecked()
  })

  it('sends only the changed fields (servings only) on submit', async () => {
    let capturedBody: unknown = null
    server.use(
      http.get('/api/groups/g1/recipes', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
      http.patch(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json(makeSlot({ servings: 6 }))
      }),
    )

    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog(makeSlot({ label: 'Spaghetti', servings: 2 }), onClose)

    const servings = screen.getByLabelText(/Portionen/i)
    await user.clear(servings)
    await user.type(servings, '6')
    await user.click(screen.getByRole('button', { name: /Speichern/i }))

    await waitFor(() => expect(capturedBody).not.toBeNull())
    expect(capturedBody).toEqual({ servings: 6 })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('sends the picked recipeId when the user selects a new recipe', async () => {
    let capturedBody: unknown = null
    server.use(
      http.get('/api/groups/g1/recipes', () =>
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
      http.patch(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json(makeSlot({ recipeId: RECIPE_ID, label: null }))
      }),
    )

    const user = userEvent.setup()
    renderDialog(makeSlot({ recipeId: null, label: 'Spaghetti' }))

    await user.type(screen.getByLabelText(/Rezept suchen/i), 'Linsen')
    const pick = await screen.findByRole('button', { name: 'Linsencurry' })
    await user.click(pick)
    await user.click(screen.getByRole('button', { name: /Speichern/i }))

    await waitFor(() => expect(capturedBody).not.toBeNull())
    const body = capturedBody as Record<string, unknown>
    expect(body.recipeId).toBe(RECIPE_ID)
    // Label should be cleared (was "Spaghetti", now recipe-only → null)
    expect(body.label).toBeNull()
    // Servings were not touched, so must not be in the body.
    expect('servings' in body).toBe(false)
  })

  it('closes without firing a request when nothing changed', async () => {
    let calledPatch = false
    server.use(
      http.get('/api/groups/g1/recipes', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
      http.patch(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, () => {
        calledPatch = true
        return HttpResponse.json(makeSlot())
      }),
    )

    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog(makeSlot({ label: 'Spaghetti', servings: 2 }), onClose)

    await user.click(screen.getByRole('button', { name: /Speichern/i }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(calledPatch).toBe(false)
  })

  // REL-3f — backend error-codes now route through `classifyMutationError`
  // → localised `errors.json` copy instead of the raw English Dev-Message.
  it('shows the localised errors:<code> copy when the PATCH fails with 400', async () => {
    server.use(
      http.get('/api/groups/g1/recipes', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
      http.patch(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, () =>
        HttpResponse.json(
          {
            code: 'invalid_input',
            message: 'Servings must be 1..50.',
            status: 400,
          },
          { status: 400 },
        ),
      ),
    )

    const user = userEvent.setup()
    renderDialog(makeSlot({ servings: 2 }))

    const servings = screen.getByLabelText(/Portionen/i)
    await user.clear(servings)
    await user.type(servings, '5')
    await user.click(screen.getByRole('button', { name: /Speichern/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Eingabe ist ungültig\./)
    expect(alert).not.toHaveTextContent(/Servings must be 1/)
  })

  it('calls onClose when the user clicks "Abbrechen"', async () => {
    server.use(
      http.get('/api/groups/g1/recipes', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
    )
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderDialog(makeSlot(), onClose)

    await user.click(screen.getByRole('button', { name: /Abbrechen/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('validates that either a recipe or a label is present', async () => {
    server.use(
      http.get('/api/groups/g1/recipes', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
    )

    const user = userEvent.setup()
    renderDialog(makeSlot({ recipeId: null, label: 'Spaghetti' }))

    // Clear the label — with no recipe attached either, submit must fail.
    await user.clear(screen.getByLabelText(/Freier Titel/i))
    await user.click(screen.getByRole('button', { name: /Speichern/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Rezept oder gib einen Titel/i,
    )
  })

  it('sends `parentSlotId: <uuid>` when the user picks a parent', async () => {
    const parent = makeSlot({
      id: 'parent-slot-id',
      label: 'Gulasch',
      date: '2026-04-20', // Mo
      meal: 'Mittag',
      servings: 4,
    })
    const child = makeSlot({ id: SLOT_ID, label: 'Rest', parentSlotId: null })
    let capturedBody: unknown = null
    server.use(
      http.get('/api/groups/g1/recipes', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
      http.patch(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ ...child, parentSlotId: 'parent-slot-id' })
      }),
    )

    const user = userEvent.setup()
    render(
      withProviders(
        <EditSlotDialog
          groupId="g1"
          weekStart="2026-04-20"
          planId={PLAN_ID}
          slot={child}
          existingSlots={[child, parent]}
          onClose={() => {}}
        />,
      ),
    )

    const parentSelect = screen.getByLabelText(/Ist Rest von/i)
    await user.selectOptions(parentSelect, 'parent-slot-id')
    await user.click(screen.getByRole('button', { name: /Speichern/i }))

    await waitFor(() => expect(capturedBody).not.toBeNull())
    expect(capturedBody).toEqual({ parentSlotId: 'parent-slot-id' })
  })

  it('sends `parentSlotId: null` when the user clears the parent', async () => {
    const parent = makeSlot({
      id: 'parent-slot-id',
      label: 'Gulasch',
      date: '2026-04-20',
      meal: 'Mittag',
      servings: 4,
    })
    const child = makeSlot({
      id: SLOT_ID,
      label: 'Rest',
      parentSlotId: 'parent-slot-id',
    })
    let capturedBody: unknown = null
    server.use(
      http.get('/api/groups/g1/recipes', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
      http.patch(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ ...child, parentSlotId: null })
      }),
    )

    const user = userEvent.setup()
    render(
      withProviders(
        <EditSlotDialog
          groupId="g1"
          weekStart="2026-04-20"
          planId={PLAN_ID}
          slot={child}
          existingSlots={[child, parent]}
          onClose={() => {}}
        />,
      ),
    )

    const parentSelect = screen.getByLabelText(/Ist Rest von/i)
    // Reset the dropdown to "— kein Parent —" (empty-string value).
    await user.selectOptions(parentSelect, '')
    await user.click(screen.getByRole('button', { name: /Speichern/i }))

    await waitFor(() => expect(capturedBody).not.toBeNull())
    expect(capturedBody).toEqual({ parentSlotId: null })
  })

  it('hides the parent dropdown when there are no eligible candidates', () => {
    server.use(
      http.get('/api/groups/g1/recipes', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 8 }),
      ),
    )
    const soleSlot = makeSlot({ id: SLOT_ID })
    render(
      withProviders(
        <EditSlotDialog
          groupId="g1"
          weekStart="2026-04-20"
          planId={PLAN_ID}
          slot={soleSlot}
          existingSlots={[soleSlot]}
          onClose={() => {}}
        />,
      ),
    )
    // The editing slot is its only candidate → excluded → dropdown hidden.
    expect(screen.queryByLabelText(/Ist Rest von/i)).not.toBeInTheDocument()
  })
})
