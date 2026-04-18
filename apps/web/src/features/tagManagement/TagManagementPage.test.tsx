import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { TagManagementPage } from './TagManagementPage'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

function renderPage(opts: { myRole: 'Admin' | 'Member' } = { myRole: 'Admin' }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  server.use(
    http.get('/api/groups/g1', () =>
      HttpResponse.json({
        id: 'g1', name: 'Testfamilie', description: null, coverImageUrl: null,
        defaultServings: 4, isPrivateCollection: false, myRole: opts.myRole,
        members: [{ userId: 'u1', displayName: 'U', role: opts.myRole, joinedAt: '2026-01-01T00:00:00Z' }],
      }),
    ),
    http.get('/api/groups/g1/tags', () =>
      HttpResponse.json([
        { id: 't-global', name: 'schnell', category: 'Aufwand', isGlobal: true, groupId: null, createdByUserId: null },
        { id: 't-custom', name: 'Omas Hit', category: 'Custom', isGlobal: false, groupId: 'g1', createdByUserId: 'u1' },
      ]),
    ),
  )
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={['/groups/g1/tags']}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/groups/:groupId/tags" element={children as React.ReactElement} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
  return render(<TagManagementPage />, { wrapper })
}

describe('TagManagementPage', () => {
  it('admin sees delete buttons for custom tags and global badge for global ones', async () => {
    renderPage({ myRole: 'Admin' })
    await waitFor(() => expect(screen.getByText(/Omas Hit/i)).toBeInTheDocument())

    // Global tag: badge, no delete button for it.
    expect(screen.getByText(/Global, nicht löschbar/i)).toBeInTheDocument()
    // Custom tag: delete button present.
    expect(screen.getByRole('button', { name: /Omas Hit.*löschen/i })).toBeInTheDocument()
  })

  it('non-admin member sees read-only banner and no delete buttons', async () => {
    renderPage({ myRole: 'Member' })
    await waitFor(() => expect(screen.getByText(/Nur Admins/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /löschen/i })).not.toBeInTheDocument()
  })

  it('admin deletes a custom tag via DELETE', async () => {
    let called = false
    server.use(
      http.delete('/api/groups/g1/tags/t-custom', () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    renderPage({ myRole: 'Admin' })
    await waitFor(() => expect(screen.getByText(/Omas Hit/i)).toBeInTheDocument())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Omas Hit.*löschen/i }))
    await waitFor(() => expect(called).toBe(true))
  })
})
