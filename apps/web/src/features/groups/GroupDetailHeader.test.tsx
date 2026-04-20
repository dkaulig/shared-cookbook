import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { GroupDetail, GroupMember } from '@familien-kochbuch/shared'
import { GroupDetailHeader } from './GroupDetailHeader'

function withRouter(node: ReactNode): ReactNode {
  return <MemoryRouter>{node}</MemoryRouter>
}

/**
 * DS4 — cover + overlapping avatar + name + description + stats row.
 * Mirrors the top section of
 * `docs/mockups/warme-kueche-group-detail.html` from `.cover` down to
 * `.group-stats-row`.
 */

const member = (userId: string, displayName: string): GroupMember => ({
  userId,
  displayName,
  role: 'Member',
  joinedAt: '2026-01-01T00:00:00Z',
})

const baseGroup: GroupDetail = {
  id: 'g1',
  name: 'Familie Kaulig',
  description: 'Sonntags kocht Oma, unter der Woche wir.',
  coverImageUrl: null,
  defaultServings: 3,
  isPrivateCollection: false,
  memberCount: 4,
  myRole: 'Admin',
  version: 0,
  members: [
    member('u1', 'David'),
    member('u2', 'Maria'),
    member('u3', 'Ilse'),
    member('u4', 'Oma'),
  ],
}

describe('<GroupDetailHeader />', () => {
  it('renders the group name as an h1 and the description below it', () => {
    render(withRouter(<GroupDetailHeader group={baseGroup} recipeCount={47} />))
    const heading = screen.getByRole('heading', { level: 1, name: 'Familie Kaulig' })
    expect(heading).toBeInTheDocument()
    expect(
      screen.getByText('Sonntags kocht Oma, unter der Woche wir.'),
    ).toBeInTheDocument()
  })

  it('shows the recipe count with "Rezepte" label', () => {
    render(withRouter(<GroupDetailHeader group={baseGroup} recipeCount={47} />))
    expect(screen.getByText('47')).toBeInTheDocument()
    expect(screen.getByText(/Rezepte/)).toBeInTheDocument()
  })

  it('renders the member avatar stack with first three initials and a "+N" chip', () => {
    render(withRouter(<GroupDetailHeader group={baseGroup} recipeCount={47} />))
    const stack = screen.getByLabelText('Mitglieder')
    expect(stack).toBeInTheDocument()
    // First three members: D, M, I
    expect(stack).toHaveTextContent('D')
    expect(stack).toHaveTextContent('M')
    expect(stack).toHaveTextContent('I')
    // 4 members total ⇒ 1 remaining after the three shown
    expect(stack).toHaveTextContent('+1')
  })

  it('omits the +N chip when member count is <= 3', () => {
    const small: GroupDetail = {
      ...baseGroup,
      memberCount: 2,
      members: [member('u1', 'Alice'), member('u2', 'Bob')],
    }
    render(withRouter(<GroupDetailHeader group={small} recipeCount={5} />))
    const stack = screen.getByLabelText('Mitglieder')
    expect(stack).toHaveTextContent('A')
    expect(stack).toHaveTextContent('B')
    expect(stack.textContent).not.toMatch(/\+\d/)
  })

  it('renders the default portions stat', () => {
    render(withRouter(<GroupDetailHeader group={baseGroup} recipeCount={47} />))
    expect(screen.getByText(/3 Portionen/)).toBeInTheDocument()
  })

  it('renders the overlapping group-avatar initial (first letter of name)', () => {
    render(withRouter(<GroupDetailHeader group={baseGroup} recipeCount={47} />))
    const avatar = screen.getByTestId('group-avatar-big')
    expect(avatar).toHaveTextContent('F')
  })

  it('renders a cover banner element with the DS4 sage gradient placeholder', () => {
    render(withRouter(<GroupDetailHeader group={baseGroup} recipeCount={47} />))
    expect(screen.getByTestId('group-cover')).toBeInTheDocument()
  })

  it('hides the description paragraph when none is provided', () => {
    render(
      withRouter(
        <GroupDetailHeader
          group={{ ...baseGroup, description: null }}
          recipeCount={0}
        />,
      ),
    )
    expect(
      screen.queryByText('Sonntags kocht Oma, unter der Woche wir.'),
    ).not.toBeInTheDocument()
  })

  it('renders a "Wochenplan" link pointing at the group meal-plan route', () => {
    render(withRouter(<GroupDetailHeader group={baseGroup} recipeCount={47} />))
    const link = screen.getByRole('link', { name: /wochenplan/i })
    expect(link).toHaveAttribute('href', '/groups/g1/mealplan')
  })

  // BUG-002 — admins now navigate to a dedicated /groups/:id/settings
  // page instead of opening an inline EditGroupDialog modal. The button
  // is rendered as an anchor (Button asChild + Link) so we assert the
  // href, not a click handler.
  it('admin sees an "Einstellungen" link pointing at the group settings page (BUG-002)', () => {
    render(withRouter(<GroupDetailHeader group={baseGroup} recipeCount={47} />))
    const link = screen.getByRole('link', { name: /einstellungen/i })
    expect(link).toHaveAttribute('href', '/groups/g1/settings')
  })

  it('member does NOT see the "Einstellungen" link', () => {
    render(
      withRouter(
        <GroupDetailHeader group={{ ...baseGroup, myRole: 'Member' }} recipeCount={47} />,
      ),
    )
    expect(
      screen.queryByRole('link', { name: /einstellungen/i }),
    ).not.toBeInTheDocument()
  })

  // BUG-005 regression — the overlapping avatar must stay at z-10 so the
  // page-scoped sticky sub-nav (z-20, on GroupDetailPage) covers it
  // while scrolling. If someone bumps this to z-20+, the avatar will
  // start eating the back-arrow + settings-cog tap-targets again.
  it('overlapping avatar wrapper sits at z-10 so sticky sub-nav (z-20) wins (BUG-005)', () => {
    render(withRouter(<GroupDetailHeader group={baseGroup} recipeCount={47} />))
    const avatar = screen.getByTestId('group-avatar-big')
    // The avatar wrapper holds the stacking context.
    const wrap = avatar.parentElement
    expect(wrap).not.toBeNull()
    expect(wrap?.className).toContain('z-10')
    expect(wrap?.className).not.toMatch(/z-(2[0-9]|3[0-9]|4[0-9]|5[0-9])/)
  })
})
