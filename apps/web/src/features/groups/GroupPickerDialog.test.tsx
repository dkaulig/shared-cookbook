import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GroupSummary } from '@familien-kochbuch/shared'
import { GroupPickerDialog } from './GroupPickerDialog'

function group(over: Partial<GroupSummary>): GroupSummary {
  return {
    id: 'g1',
    name: 'Example Family',
    description: null,
    coverImageUrl: null,
    defaultServings: 3,
    isPrivateCollection: false,
    memberCount: 4,
    myRole: 'Admin',
    ...over,
  }
}

describe('<GroupPickerDialog />', () => {
  it('renders the dialog with a per-group choice button', () => {
    render(
      <GroupPickerDialog
        groups={[
          group({ id: 'gA', name: 'Example Family', memberCount: 4 }),
          group({ id: 'gB', name: 'WG-Donnerstage', memberCount: 3 }),
        ]}
        onPick={() => {}}
        onClose={() => {}}
      />,
    )
    const dialog = screen.getByRole('dialog', { name: /in welcher gruppe suchen/i })
    expect(within(dialog).getByRole('button', { name: /familie kaulig/i })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /wg-donnerstage/i })).toBeInTheDocument()
  })

  it('reports a member-count line per group (private collections collapse to "nur du")', () => {
    render(
      <GroupPickerDialog
        groups={[
          group({ id: 'gA', name: 'Privat', memberCount: 1, isPrivateCollection: true }),
          group({ id: 'gB', name: 'Familie', memberCount: 5 }),
        ]}
        onPick={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/nur du/i)).toBeInTheDocument()
    expect(screen.getByText(/5 mitglieder/i)).toBeInTheDocument()
  })

  it('calls onPick with the chosen group', async () => {
    const onPick = vi.fn()
    render(
      <GroupPickerDialog
        groups={[
          group({ id: 'gA', name: 'Example Family' }),
          group({ id: 'gB', name: 'WG-Donnerstage' }),
        ]}
        onPick={onPick}
        onClose={() => {}}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /wg-donnerstage/i }))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0].id).toBe('gB')
  })

  it('calls onClose when the backdrop is clicked', async () => {
    const onClose = vi.fn()
    render(
      <GroupPickerDialog
        groups={[group({ id: 'gA' })]}
        onPick={() => {}}
        onClose={onClose}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(
      <GroupPickerDialog
        groups={[group({ id: 'gA' })]}
        onPick={() => {}}
        onClose={onClose}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('focuses the first group choice on mount', () => {
    render(
      <GroupPickerDialog
        groups={[
          group({ id: 'gA', name: 'Example Family' }),
          group({ id: 'gB', name: 'WG' }),
        ]}
        onPick={() => {}}
        onClose={() => {}}
      />,
    )
    const first = screen.getByRole('button', { name: /familie kaulig/i })
    expect(document.activeElement).toBe(first)
  })
})
