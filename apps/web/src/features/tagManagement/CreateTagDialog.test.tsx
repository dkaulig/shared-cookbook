import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { TagDto } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { CreateTagDialog } from './CreateTagDialog'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

function renderDialog(onClose = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(<CreateTagDialog groupId="g1" onClose={onClose} />, { wrapper })
}

describe('CreateTagDialog', () => {
  it('submits name + category and closes on success', async () => {
    let body: unknown = null
    server.use(
      http.post('/api/groups/g1/tags', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json<TagDto>({
          id: 't-new', name: 'Omas Rezepte', category: 'Custom',
          isGlobal: false, groupId: 'g1', createdByUserId: 'u1',
        }, { status: 201 })
      }),
    )

    let closed = false
    renderDialog(() => { closed = true })

    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/Name/i), 'Omas Rezepte')
    await user.click(screen.getByRole('button', { name: /Tag anlegen/i }))

    await waitFor(() => expect(body).toEqual({ name: 'Omas Rezepte', category: 'Custom' }))
    await waitFor(() => expect(closed).toBe(true))
  })

  it('shows API error message on duplicate', async () => {
    server.use(
      http.post('/api/groups/g1/tags', () =>
        HttpResponse.json({ code: 'tag_exists', message: 'Dieser Tag existiert schon.' }, { status: 400 }),
      ),
    )
    renderDialog()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/Name/i), 'Dup')
    await user.click(screen.getByRole('button', { name: /Tag anlegen/i }))
    await waitFor(() =>
      expect(screen.getByText(/Dieser Tag existiert schon/i)).toBeInTheDocument(),
    )
  })

  it('rejects blank name without calling API', async () => {
    let called = false
    server.use(
      http.post('/api/groups/g1/tags', () => {
        called = true
        return new HttpResponse(null, { status: 201 })
      }),
    )
    renderDialog()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Tag anlegen/i }))
    expect(called).toBe(false)
    expect(screen.getByText(/Name ist erforderlich/i)).toBeInTheDocument()
  })
})
