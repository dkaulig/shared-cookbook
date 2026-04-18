import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { EditGroupDialog } from './EditGroupDialog'

function renderDialog(onClose: () => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return render(
    <EditGroupDialog
      groupId="g1"
      initialName="Familie"
      initialDescription="Unsere Sammlung"
      initialDefaultServings={2}
      initialCoverImageUrl=""
      onClose={onClose}
    />,
    { wrapper: Wrapper },
  )
}

describe('<EditGroupDialog />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'x@y.de',
      displayName: 'X',
      role: 'User',
    })
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('seeds the default-servings input with the initial value', () => {
    renderDialog()
    expect(screen.getByLabelText(/Standard-Portionen/i)).toHaveValue(2)
  })

  it('submits the fractional default-servings value to the PUT endpoint', async () => {
    let captured: unknown
    server.use(
      http.put('/api/groups/g1', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json({
          id: 'g1',
          name: 'Familie',
          description: 'Unsere Sammlung',
          coverImageUrl: null,
          defaultServings: 2.5,
          isPrivateCollection: false,
          memberCount: 1,
          myRole: 'Admin',
        })
      }),
    )

    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog(onClose)

    const input = screen.getByLabelText(/Standard-Portionen/i)
    await user.clear(input)
    await user.type(input, '2.5')
    await user.click(screen.getByRole('button', { name: /speichern/i }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
    expect(captured).toMatchObject({ defaultServings: 2.5 })
  })

  it('blocks submission and shows a German error when default-servings is zero', async () => {
    const user = userEvent.setup()
    renderDialog()

    const input = screen.getByLabelText(/Standard-Portionen/i)
    await user.clear(input)
    await user.type(input, '0')
    await user.click(screen.getByRole('button', { name: /speichern/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Standard-Portionen muss/i)
  })

  it('blocks submission and shows a German error when default-servings exceeds 20', async () => {
    const user = userEvent.setup()
    renderDialog()

    const input = screen.getByLabelText(/Standard-Portionen/i)
    await user.clear(input)
    await user.type(input, '25')
    await user.click(screen.getByRole('button', { name: /speichern/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/(höchstens|max)/i)
  })

  it('surfaces API error messages when the server rejects the value', async () => {
    server.use(
      http.put('/api/groups/g1', () =>
        HttpResponse.json(
          { code: 'invalid_input', message: 'Standard-Portionen muss > 0 sein.' },
          { status: 400 },
        ),
      ),
    )

    const user = userEvent.setup()
    renderDialog()

    const input = screen.getByLabelText(/Standard-Portionen/i)
    await user.clear(input)
    await user.type(input, '3')
    await user.click(screen.getByRole('button', { name: /speichern/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/> 0 sein/)
  })
})
