import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GroupDetail, GroupMember } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { GroupMembersAndInvitesPanel } from './GroupMembersAndInvitesPanel'

/**
 * GM1 — Admin + member view of a group's members and outstanding
 * invites. The panel is the primary surface for the three admin
 * workflows introduced in this slice: role change, remove, revoke
 * invite.
 */

const member = (userId: string, displayName: string, role: 'Admin' | 'Member'): GroupMember => ({
  userId,
  displayName,
  role,
  joinedAt: '2026-01-01T00:00:00Z',
})

function groupWith(overrides: Partial<GroupDetail> = {}): GroupDetail {
  const base: GroupDetail = {
    id: 'g1',
    name: 'Example Family',
    description: null,
    coverImageUrl: null,
    defaultServings: 3,
    isPrivateCollection: false,
    memberCount: 3,
    myRole: 'Admin',
    members: [
      member('u1', 'Alice', 'Admin'),
      member('u2', 'Bob', 'Member'),
      member('u3', 'Charlie', 'Member'),
    ],
  }
  return { ...base, ...overrides }
}

function renderPanel(group: GroupDetail) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  const utils = render(<GroupMembersAndInvitesPanel group={group} />, { wrapper: Wrapper })
  return { ...utils, client }
}

beforeEach(() => {
  useAuthStore.getState().setSession('tok', {
    id: 'u1',
    email: 'x@y.de',
    displayName: 'Alice',
    role: 'User',
  })
})
afterEach(() => {
  server.resetHandlers()
  useAuthStore.getState().clear()
  vi.restoreAllMocks()
})

describe('<GroupMembersAndInvitesPanel /> — members list', () => {
  it('renders every member with displayName and role badge', () => {
    server.use(http.get('/api/groups/g1/invites', () => HttpResponse.json([])))
    renderPanel(groupWith())

    const list = screen.getByRole('list', { name: /mitglieder/i })
    expect(within(list).getByText('Alice')).toBeInTheDocument()
    expect(within(list).getByText('Bob')).toBeInTheDocument()
    expect(within(list).getByText('Charlie')).toBeInTheDocument()
    // Alice has the Admin badge; Bob/Charlie carry the Member badge.
    expect(within(list).getAllByText('Admin').length).toBeGreaterThanOrEqual(1)
    expect(within(list).getAllByText('Mitglied').length).toBeGreaterThanOrEqual(2)
  })

  it('admin sees a role dropdown for a non-last-admin member', async () => {
    server.use(http.get('/api/groups/g1/invites', () => HttpResponse.json([])))
    renderPanel(
      groupWith({
        memberCount: 3,
        members: [
          member('u1', 'Alice', 'Admin'),
          member('u2', 'Bob', 'Admin'),
          member('u3', 'Charlie', 'Member'),
        ],
      }),
    )

    // Bob is the second admin — demoting him is allowed.
    expect(screen.getByLabelText(/rolle von bob/i)).toBeInTheDocument()
  })

  it('hides role dropdown + remove button for the last remaining admin', () => {
    server.use(http.get('/api/groups/g1/invites', () => HttpResponse.json([])))
    renderPanel(groupWith())

    // Alice is the only admin — no role control for her.
    expect(screen.queryByLabelText(/rolle von alice/i)).not.toBeInTheDocument()
    // And no remove button either.
    expect(
      screen.queryByRole('button', { name: /alice.*entfernen/i }),
    ).not.toBeInTheDocument()
    expect(screen.getByText(/letzter admin/i)).toBeInTheDocument()
  })

  it('members do NOT see role dropdowns or remove buttons', () => {
    server.use(http.get('/api/groups/g1/invites', () => HttpResponse.json([])))
    renderPanel(groupWith({ myRole: 'Member' }))

    expect(screen.queryByLabelText(/rolle von/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /entfernen/i })).not.toBeInTheDocument()
  })

  it('admin can change a non-last-admin member role via the dropdown', async () => {
    server.use(http.get('/api/groups/g1/invites', () => HttpResponse.json([])))
    let putBody: unknown = null
    server.use(
      http.put('/api/groups/g1/members/u2', async ({ request }) => {
        putBody = await request.json()
        return HttpResponse.json({
          userId: 'u2',
          displayName: 'Bob',
          role: 'Admin',
          joinedAt: '2026-01-01T00:00:00Z',
        })
      }),
    )
    renderPanel(groupWith())

    const select = screen.getByLabelText(/rolle von bob/i) as HTMLSelectElement
    const user = userEvent.setup()
    await user.selectOptions(select, 'Admin')
    await waitFor(() => expect(putBody).toEqual({ role: 'Admin' }))
  })

  it('admin can remove a member after confirming via the ConfirmDialog', async () => {
    server.use(http.get('/api/groups/g1/invites', () => HttpResponse.json([])))
    let deleted = false
    server.use(
      http.delete('/api/groups/g1/members/u2', () => {
        deleted = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    // BUG-004 — no more native `window.confirm`; action flows through
    // the shared ConfirmDialog primitive.
    renderPanel(groupWith())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /bob.*entfernen/i }))
    expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /Mitglied entfernen\?/i }),
    ).toBeInTheDocument()
    // DELETE hasn't fired yet.
    expect(deleted).toBe(false)

    await user.click(screen.getByRole('button', { name: /^Entfernen$/i }))
    await waitFor(() => expect(deleted).toBe(true))
  })

  it('remove is skipped when the ConfirmDialog is cancelled', async () => {
    server.use(http.get('/api/groups/g1/invites', () => HttpResponse.json([])))
    let deleted = false
    server.use(
      http.delete('/api/groups/g1/members/u2', () => {
        deleted = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    renderPanel(groupWith())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /bob.*entfernen/i }))
    await user.click(screen.getByRole('button', { name: /^Abbrechen$/i }))
    // Nothing happens — no network hit.
    expect(deleted).toBe(false)
    await waitFor(() =>
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument(),
    )
  })
})

describe('<GroupMembersAndInvitesPanel /> — invites list', () => {
  it('admin sees outstanding invites with invited user display names', async () => {
    server.use(
      http.get('/api/groups/g1/invites', () =>
        HttpResponse.json([
          {
            id: 'i1',
            groupId: 'g1',
            invitedUserId: 'u9',
            invitedUserDisplayName: 'Diana',
            status: 'Pending',
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
    )
    renderPanel(groupWith())

    await waitFor(() => expect(screen.getByText('Diana')).toBeInTheDocument())
    expect(
      screen.getByRole('heading', { name: /offene einladungen/i }),
    ).toBeInTheDocument()
  })

  it('admin sees a German empty-state when no invites are outstanding', async () => {
    server.use(http.get('/api/groups/g1/invites', () => HttpResponse.json([])))
    renderPanel(groupWith())

    await waitFor(() =>
      expect(screen.getByText(/keine offenen einladungen/i)).toBeInTheDocument(),
    )
  })

  it('admin can revoke an outstanding invite after ConfirmDialog confirmation', async () => {
    let revoked = false
    server.use(
      http.get('/api/groups/g1/invites', () =>
        HttpResponse.json([
          {
            id: 'i1',
            groupId: 'g1',
            invitedUserId: 'u9',
            invitedUserDisplayName: 'Diana',
            status: 'Pending',
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
      http.delete('/api/groups/invites/i1', () => {
        revoked = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    renderPanel(groupWith())

    await waitFor(() => expect(screen.getByText('Diana')).toBeInTheDocument())
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /diana.*zurückziehen/i }))
    expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Zurückziehen$/i }))
    await waitFor(() => expect(revoked).toBe(true))
  })

  it('members do NOT see the invites section at all', async () => {
    // Still stub the endpoint — members won't call it but the MSW handler
    // absence would otherwise surface as a noisy unhandled-request warning.
    server.use(http.get('/api/groups/g1/invites', () => HttpResponse.json([])))
    renderPanel(groupWith({ myRole: 'Member' }))

    expect(
      screen.queryByRole('heading', { name: /offene einladungen/i }),
    ).not.toBeInTheDocument()
  })

  it('admin sees an "Mitglied einladen" button that opens the invite dialog', async () => {
    server.use(http.get('/api/groups/g1/invites', () => HttpResponse.json([])))
    renderPanel(groupWith())

    const user = userEvent.setup()
    const btn = screen.getByRole('button', { name: /mitglied einladen/i })
    await user.click(btn)
    expect(
      screen.getByRole('heading', { level: 2, name: /mitglied einladen/i }),
    ).toBeInTheDocument()
  })

  it('members do NOT see the "Mitglied einladen" button', () => {
    server.use(http.get('/api/groups/g1/invites', () => HttpResponse.json([])))
    renderPanel(groupWith({ myRole: 'Member' }))
    expect(
      screen.queryByRole('button', { name: /mitglied einladen/i }),
    ).not.toBeInTheDocument()
  })
})
