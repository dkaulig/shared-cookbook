import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ForkRecipeDialog } from './ForkRecipeDialog'

const GROUPS = [
  {
    id: 'g-source',
    name: 'Meine Sammlung',
    description: null,
    coverImageUrl: null,
    defaultServings: 2,
    isPrivateCollection: true,
    memberCount: 1,
    myRole: 'Admin',
  },
  {
    id: 'g-target',
    name: 'Gemeinsame Küche',
    description: null,
    coverImageUrl: null,
    defaultServings: 4,
    isPrivateCollection: false,
    memberCount: 2,
    myRole: 'Member',
  },
  {
    id: 'g-target-2',
    name: 'Grillclub',
    description: null,
    coverImageUrl: null,
    defaultServings: 6,
    isPrivateCollection: false,
    memberCount: 3,
    myRole: 'Admin',
  },
]

function PathTracker() {
  const location = useLocation()
  return <div data-testid="current-path">{location.pathname}</div>
}

function renderDialog(onClose: () => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/start']}>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  <PathTracker />
                  {children}
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(
    <ForkRecipeDialog recipeId="r-source" sourceGroupId="g-source" onClose={onClose} />,
    { wrapper: Wrapper },
  )
}

describe('<ForkRecipeDialog />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'x@y.de',
      displayName: 'X',
      role: 'User',
    })
    server.use(http.get('/api/groups', () => HttpResponse.json(GROUPS)))
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('shows a dropdown of user groups excluding the source group', async () => {
    renderDialog()
    expect(await screen.findByRole('heading', { name: /In andere Gruppe kopieren/i })).toBeInTheDocument()
    // Wait for the async groups fetch to settle.
    expect(await screen.findByRole('option', { name: 'Gemeinsame Küche' })).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: 'Grillclub' })).toBeInTheDocument()
    // Source group "Meine Sammlung" must NOT be listed.
    expect(screen.queryByRole('option', { name: 'Meine Sammlung' })).not.toBeInTheDocument()
  })

  it('submits the fork mutation and navigates to the new recipe', async () => {
    let captured: unknown
    server.use(
      http.post('/api/recipes/r-source/fork', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json(
          {
            id: 'r-forked',
            groupId: 'g-target',
            createdByUserId: 'u1',
            createdByDisplayName: 'X',
            title: 'Spätzle',
            description: null,
            defaultServings: 4,
            prepTimeMinutes: 30,
            difficulty: 1,
            sourceUrl: null,
            sourceType: 'Manual',
            forkOfRecipeId: 'r-source',
            photos: [],
            lastCookedAt: null,
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

    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog(onClose)

    const select = await screen.findByLabelText(/Zielgruppe/i)
    // Wait until the option has rendered (groups fetch resolved).
    await screen.findByRole('option', { name: 'Gemeinsame Küche' })
    await user.selectOptions(select, 'g-target')
    await user.click(screen.getByRole('button', { name: /Kopieren/i }))

    await waitFor(() => {
      expect(captured).toEqual({ targetGroupId: 'g-target' })
    })
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByTestId('current-path')).toHaveTextContent(
        '/groups/g-target/recipes/r-forked',
      )
    })
  })

  it('disables submit until a target group is picked', async () => {
    renderDialog()
    // No selection → button disabled.
    const button = await screen.findByRole('button', { name: /Kopieren/i })
    expect(button).toBeDisabled()
  })

  it('renders a German error when the API returns 403', async () => {
    server.use(
      http.post('/api/recipes/r-source/fork', () =>
        HttpResponse.json(
          { code: 'forbidden', message: 'Du bist nicht Mitglied dieser Gruppe.' },
          { status: 403 },
        ),
      ),
    )

    const user = userEvent.setup()
    renderDialog()

    const select = await screen.findByLabelText(/Zielgruppe/i)
    // Wait until the option has rendered (groups fetch resolved).
    await screen.findByRole('option', { name: 'Gemeinsame Küche' })
    await user.selectOptions(select, 'g-target')
    await user.click(screen.getByRole('button', { name: /Kopieren/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Mitglied dieser Gruppe/)
  })
})
