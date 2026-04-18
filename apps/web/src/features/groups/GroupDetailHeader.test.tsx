import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { GroupDetail, GroupMember } from '@familien-kochbuch/shared'
import { GroupDetailHeader } from './GroupDetailHeader'

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
  members: [
    member('u1', 'David'),
    member('u2', 'Maria'),
    member('u3', 'Ilse'),
    member('u4', 'Oma'),
  ],
}

describe('<GroupDetailHeader />', () => {
  it('renders the group name as an h1 and the description below it', () => {
    render(<GroupDetailHeader group={baseGroup} recipeCount={47} />)
    const heading = screen.getByRole('heading', { level: 1, name: 'Familie Kaulig' })
    expect(heading).toBeInTheDocument()
    expect(
      screen.getByText('Sonntags kocht Oma, unter der Woche wir.'),
    ).toBeInTheDocument()
  })

  it('shows the recipe count with "Rezepte" label', () => {
    render(<GroupDetailHeader group={baseGroup} recipeCount={47} />)
    expect(screen.getByText('47')).toBeInTheDocument()
    expect(screen.getByText(/Rezepte/)).toBeInTheDocument()
  })

  it('renders the member avatar stack with first three initials and a "+N" chip', () => {
    render(<GroupDetailHeader group={baseGroup} recipeCount={47} />)
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
    render(<GroupDetailHeader group={small} recipeCount={5} />)
    const stack = screen.getByLabelText('Mitglieder')
    expect(stack).toHaveTextContent('A')
    expect(stack).toHaveTextContent('B')
    expect(stack.textContent).not.toMatch(/\+\d/)
  })

  it('renders the default portions stat', () => {
    render(<GroupDetailHeader group={baseGroup} recipeCount={47} />)
    expect(screen.getByText(/3 Portionen/)).toBeInTheDocument()
  })

  it('renders the overlapping group-avatar initial (first letter of name)', () => {
    render(<GroupDetailHeader group={baseGroup} recipeCount={47} />)
    const avatar = screen.getByTestId('group-avatar-big')
    expect(avatar).toHaveTextContent('F')
  })

  it('renders a cover banner element with the DS4 amber gradient placeholder', () => {
    render(<GroupDetailHeader group={baseGroup} recipeCount={47} />)
    expect(screen.getByTestId('group-cover')).toBeInTheDocument()
  })

  it('hides the description paragraph when none is provided', () => {
    render(
      <GroupDetailHeader
        group={{ ...baseGroup, description: null }}
        recipeCount={0}
      />,
    )
    expect(
      screen.queryByText('Sonntags kocht Oma, unter der Woche wir.'),
    ).not.toBeInTheDocument()
  })
})
