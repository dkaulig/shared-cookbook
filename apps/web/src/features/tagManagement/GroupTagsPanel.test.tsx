import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { GroupTagsPanel } from './GroupTagsPanel'

/**
 * BUG-020 — the per-group tag-management UI is now a reusable panel.
 * These tests cover the panel in isolation; the route-level mounting
 * inside `GroupSettingsPage` is covered separately by
 * `GroupSettingsPage.test.tsx`.
 */

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

function renderPanel(opts: { myRole: 'Admin' | 'Member' } = { myRole: 'Admin' }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  server.use(
    http.get('/api/groups/g1', () =>
      HttpResponse.json({
        id: 'g1',
        name: 'Testfamilie',
        description: null,
        coverImageUrl: null,
        defaultServings: 4,
        isPrivateCollection: false,
        myRole: opts.myRole,
        members: [
          {
            userId: 'u1',
            displayName: 'U',
            role: opts.myRole,
            joinedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    ),
    http.get('/api/groups/g1/tags', () =>
      HttpResponse.json([
        {
          id: 't-global',
          name: 'schnell',
          category: 'Aufwand',
          isGlobal: true,
          groupId: null,
          createdByUserId: null,
        },
        {
          id: 't-custom',
          name: 'Omas Hit',
          category: 'Custom',
          isGlobal: false,
          groupId: 'g1',
          createdByUserId: 'u1',
        },
      ]),
    ),
  )
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </MemoryRouter>
  )
  return render(<GroupTagsPanel groupId="g1" />, { wrapper })
}

describe('<GroupTagsPanel />', () => {
  it('admin sees delete buttons for custom tags and global badge for global ones', async () => {
    renderPanel({ myRole: 'Admin' })
    await waitFor(() => expect(screen.getByText(/Omas Hit/i)).toBeInTheDocument())
    expect(screen.getByText(/Global, nicht löschbar/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Omas Hit.*löschen/i })).toBeInTheDocument()
  })

  it('non-admin member sees the read-only banner and no delete buttons', async () => {
    renderPanel({ myRole: 'Member' })
    await waitFor(() => expect(screen.getByText(/Nur Admins/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /löschen/i })).not.toBeInTheDocument()
  })

  it('admin deletes a custom tag via DELETE after confirming in the modal', async () => {
    let called = false
    server.use(
      http.delete('/api/groups/g1/tags/t-custom', () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    renderPanel({ myRole: 'Admin' })
    await waitFor(() => expect(screen.getByText(/Omas Hit/i)).toBeInTheDocument())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Omas Hit.*löschen/i }))
    expect(called).toBe(false)
    expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Löschen$/i }))
    await waitFor(() => expect(called).toBe(true))
  })

  it('admin cancelling the confirm dialog does NOT fire DELETE', async () => {
    let called = false
    server.use(
      http.delete('/api/groups/g1/tags/t-custom', () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    renderPanel({ myRole: 'Admin' })
    await waitFor(() => expect(screen.getByText(/Omas Hit/i)).toBeInTheDocument())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Omas Hit.*löschen/i }))
    await user.click(screen.getByRole('button', { name: /^Abbrechen$/i }))
    expect(called).toBe(false)
    await waitFor(() =>
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument(),
    )
  })
})
