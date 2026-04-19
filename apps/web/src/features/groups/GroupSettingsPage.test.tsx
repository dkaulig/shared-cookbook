import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GroupDetail } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { GroupSettingsPage } from './GroupSettingsPage'

/**
 * BUG-002 + BUG-003 — regression coverage for the new settings page.
 *
 * The page consolidates name + description + portions edit (the old
 * EditGroupDialog fields), single-image cover upload (replaces the
 * URL text input), and the existing GroupMembersAndInvitesPanel into
 * one routed surface at `/groups/:groupId/settings`.
 */

const detail: GroupDetail = {
  id: 'g1',
  name: 'Example Family',
  description: 'Sonntags kocht Oma.',
  coverImageUrl: null,
  defaultServings: 3,
  isPrivateCollection: false,
  memberCount: 2,
  myRole: 'Admin',
  members: [
    { userId: 'u1', displayName: 'Alice', role: 'Admin', joinedAt: '2026-01-01T00:00:00Z' },
    { userId: 'u2', displayName: 'Bob', role: 'Member', joinedAt: '2026-01-01T00:00:00Z' },
  ],
}

function renderAt(path: string): { client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  render(
    <Wrapper>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/groups/:groupId/settings" element={<GroupSettingsPage />} />
          <Route path="/groups/:id" element={<div data-testid="group-detail">detail</div>} />
          <Route path="/groups" element={<div data-testid="groups-list">groups</div>} />
        </Routes>
      </MemoryRouter>
    </Wrapper>,
  )
  return { client }
}

beforeEach(() => {
  useAuthStore.getState().setSession('tok', {
    id: 'u1',
    email: 'alice@ex.com',
    displayName: 'Alice',
    role: 'User',
  })
  // Default group + invites handlers — individual tests can override.
  server.use(
    http.get('/api/groups/g1', () => HttpResponse.json(detail)),
    http.get('/api/groups/g1/invites', () => HttpResponse.json([])),
  )
})

afterEach(() => {
  server.resetHandlers()
  useAuthStore.getState().clear()
})

describe('<GroupSettingsPage />', () => {
  it('renders the name input, photo section, and members panel together', async () => {
    renderAt('/groups/g1/settings')

    // Name field seeded from GroupDetail.
    const nameInput = await screen.findByLabelText('Name')
    expect(nameInput).toHaveValue('Example Family')

    // Photo section renders with the upload button.
    expect(screen.getByRole('heading', { name: /gruppen-foto/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /foto hochladen/i })).toBeInTheDocument()

    // Members panel rendered inline (not behind a toggle).
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /mitglieder & einladungen/i }),
      ).toBeInTheDocument()
    })
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
  })

  it('saves name + description + default-servings via PUT /api/groups/{id}', async () => {
    let putBody: unknown = null
    server.use(
      http.put('/api/groups/g1', async ({ request }) => {
        putBody = await request.json()
        return HttpResponse.json({
          id: 'g1',
          name: 'Familie K.',
          description: 'Sonntags kocht Oma.',
          coverImageUrl: null,
          defaultServings: 4,
          isPrivateCollection: false,
          memberCount: 2,
          myRole: 'Admin',
        })
      }),
    )

    renderAt('/groups/g1/settings')

    const nameInput = await screen.findByLabelText('Name')
    const user = userEvent.setup()
    await user.clear(nameInput)
    await user.type(nameInput, 'Familie K.')

    const portionsInput = screen.getByLabelText(/Standard-Portionen/i)
    await user.clear(portionsInput)
    await user.type(portionsInput, '4')

    await user.click(screen.getByRole('button', { name: /^speichern$/i }))

    await waitFor(() => {
      expect(putBody).toMatchObject({
        name: 'Familie K.',
        defaultServings: 4,
      })
    })
    expect(await screen.findByText(/einstellungen gespeichert/i)).toBeInTheDocument()
  })

  it('uploads a chosen photo via the staged-photo endpoint and previews the signed URL (BUG-003)', async () => {
    let stagedHits = 0
    server.use(
      http.post('/api/recipes/photos/staged', async () => {
        stagedHits += 1
        return HttpResponse.json({
          photoId: 'recipes/abc.jpg',
          signedUrl: 'https://example.test/api/photos/recipes/abc.jpg?sig=X&exp=999',
          stagedPhotoId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        })
      }),
    )

    renderAt('/groups/g1/settings')
    await screen.findByLabelText('Name')

    const fileInput = screen.getByTestId('group-photo-input') as HTMLInputElement
    const file = new File(['hello'], 'cover.jpg', { type: 'image/jpeg' })
    const user = userEvent.setup()
    await user.upload(fileInput, file)

    await waitFor(() => expect(stagedHits).toBe(1))
    const preview = await screen.findByRole('img', { name: /gruppen-foto vorschau/i })
    expect(preview).toHaveAttribute(
      'src',
      'https://example.test/api/photos/recipes/abc.jpg?sig=X&exp=999',
    )
    // After upload the user can remove the photo to reset.
    expect(
      screen.getByRole('button', { name: /foto entfernen/i }),
    ).toBeInTheDocument()
  })

  it('persists the uploaded coverImageUrl on submit (BUG-003 end-to-end)', async () => {
    server.use(
      http.post('/api/recipes/photos/staged', () =>
        HttpResponse.json({
          photoId: 'recipes/abc.jpg',
          signedUrl: 'https://example.test/api/photos/recipes/abc.jpg?sig=X&exp=999',
          stagedPhotoId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        }),
      ),
    )
    let putBody: { coverImageUrl?: string | undefined } | null = null
    server.use(
      http.put('/api/groups/g1', async ({ request }) => {
        putBody = (await request.json()) as { coverImageUrl?: string }
        return HttpResponse.json({
          id: 'g1',
          name: 'Example Family',
          description: 'Sonntags kocht Oma.',
          coverImageUrl: putBody?.coverImageUrl ?? null,
          defaultServings: 3,
          isPrivateCollection: false,
          memberCount: 2,
          myRole: 'Admin',
        })
      }),
    )

    renderAt('/groups/g1/settings')
    await screen.findByLabelText('Name')

    const fileInput = screen.getByTestId('group-photo-input') as HTMLInputElement
    const file = new File(['hello'], 'cover.jpg', { type: 'image/jpeg' })
    const user = userEvent.setup()
    await user.upload(fileInput, file)

    await screen.findByRole('img', { name: /gruppen-foto vorschau/i })

    await user.click(screen.getByRole('button', { name: /^speichern$/i }))

    await waitFor(() => {
      expect(putBody).toMatchObject({
        coverImageUrl: 'https://example.test/api/photos/recipes/abc.jpg?sig=X&exp=999',
      })
    })
  })

  it('rejects an unsupported file type and surfaces a German error', async () => {
    renderAt('/groups/g1/settings')
    await screen.findByLabelText('Name')

    // userEvent.upload() honours the input's `accept` attribute and
    // would silently drop a HEIC file before the change handler runs —
    // which is exactly the browser behaviour that prompted BUG-015's
    // dual-input split, but here we want to verify the in-component
    // MIME guard fires when (e.g.) a drag-and-drop sneaks one through.
    // We dispatch a synthetic change event with a HEIC File directly.
    const fileInput = screen.getByTestId('group-photo-input') as HTMLInputElement
    const heic = new File(['x'], 'photo.heic', { type: 'image/heic' })
    Object.defineProperty(fileInput, 'files', { value: [heic], configurable: true })
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/JPG, PNG oder WebP/i)
  })

  it('redirects non-admin members back to the group detail page', async () => {
    server.use(
      http.get('/api/groups/g1', () =>
        HttpResponse.json({ ...detail, myRole: 'Member' }),
      ),
    )
    renderAt('/groups/g1/settings')

    await waitFor(() => {
      expect(screen.getByTestId('group-detail')).toBeInTheDocument()
    })
  })
})
