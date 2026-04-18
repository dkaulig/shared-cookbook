import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { useSession } from './useSession'
import { useAuthStore } from './authStore'
import { server } from '@/test/msw/server'

function TestConsumer() {
  const { status, user } = useSession()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.displayName ?? ''}</span>
    </div>
  )
}

describe('useSession', () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
  })

  afterEach(() => {
    server.resetHandlers()
  })

  it('performs silent refresh on mount and flips to authenticated when it succeeds', async () => {
    server.use(
      http.post('/api/auth/refresh', () =>
        HttpResponse.json({
          accessToken: 'rehydrated',
          user: { id: 'u1', email: 'user@example.com', displayName: 'Oma', role: 'User' },
        }),
      ),
    )

    const { getByTestId } = render(<TestConsumer />)

    await waitFor(() => {
      expect(getByTestId('status').textContent).toBe('authenticated')
    })
    expect(getByTestId('user').textContent).toBe('Oma')
  })

  it('flips to anonymous when silent refresh returns 401', async () => {
    server.use(http.post('/api/auth/refresh', () => new HttpResponse(null, { status: 401 })))

    const { getByTestId } = render(<TestConsumer />)

    await waitFor(() => {
      expect(getByTestId('status').textContent).toBe('anonymous')
    })
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })
})
