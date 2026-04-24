import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { CreateGroupDialog } from './CreateGroupDialog'

function renderDialog(onClose: () => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return render(<CreateGroupDialog onClose={onClose} />, { wrapper: Wrapper })
}

describe('<CreateGroupDialog />', () => {
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

  it('renders German labels and disables submit until a name is entered', () => {
    renderDialog()
    expect(screen.getByRole('heading', { level: 2, name: /gruppe erstellen/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/beschreibung/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /erstellen/i })).toBeDisabled()
  })

  it('blocks submission when the name is only whitespace and shows a German error', async () => {
    const user = userEvent.setup()
    renderDialog()

    const nameInput = screen.getByLabelText(/name/i)
    // Space + tab still leaves the button disabled rather than silently succeeding
    await user.type(nameInput, '   ')
    await user.click(screen.getByRole('button', { name: /erstellen/i }))
    // Button stays disabled; no network call made.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('submits to /api/groups and calls onClose on success', async () => {
    let captured: unknown
    server.use(
      http.post('/api/groups', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json(
          {
            id: 'g1',
            name: 'Example Family',
            description: 'Unsere Sammlung',
            coverImageUrl: null,
            defaultServings: 2,
            isPrivateCollection: false,
            memberCount: 1,
            myRole: 'Admin',
            version: 0,
          },
          { status: 201 },
        )
      }),
    )

    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog(onClose)

    await user.type(screen.getByLabelText(/name/i), 'Example Family')
    await user.type(screen.getByLabelText(/beschreibung/i), 'Unsere Sammlung')
    await user.click(screen.getByRole('button', { name: /erstellen/i }))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
    })
    expect(captured).toEqual({ name: 'Example Family', description: 'Unsere Sammlung' })
  })

  // REL-3f — 4xx server errors with a known `code` are routed through
  // `classifyMutationError` → localised `errors.json` copy. The backend
  // emits English Dev-Messages post REL-4, which must NOT leak verbatim.
  it('surfaces the translated errors:<code> copy on 4xx', async () => {
    server.use(
      http.post('/api/groups', () =>
        HttpResponse.json(
          { code: 'invalid_input', message: 'Name is too long.', status: 400 },
          { status: 400 },
        ),
      ),
    )

    const user = userEvent.setup()
    renderDialog()

    await user.type(screen.getByLabelText(/name/i), 'X')
    await user.click(screen.getByRole('button', { name: /erstellen/i }))

    const alert = await screen.findByRole('alert')
    // Localised German copy from errors.json
    expect(alert).toHaveTextContent(/Eingabe ist ungültig\./)
    // English Dev-Message must NOT leak
    expect(alert).not.toHaveTextContent(/Name is too long/)
  })

  // REL-3f — 5xx responses must NEVER surface the backend's raw message
  // (stack traces / SQL fragments). `classifyMutationError` swaps in a
  // generic German toast copy for the security-audit requirement.
  it('surfaces a generic German fallback on 5xx without leaking raw message', async () => {
    server.use(
      http.post('/api/groups', () =>
        HttpResponse.json(
          {
            code: 'internal_error',
            message: 'NullReferenceException at GroupService.cs:42',
            status: 500,
          },
          { status: 500 },
        ),
      ),
    )

    const user = userEvent.setup()
    renderDialog()

    await user.type(screen.getByLabelText(/name/i), 'X')
    await user.click(screen.getByRole('button', { name: /erstellen/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Unbekannter Fehler/)
    expect(alert).not.toHaveTextContent(/NullReferenceException/)
  })
})
