import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ChatSessionListItem } from '@shared-cookbook/shared'
import { ChatSessionsList } from './ChatSessionsList'

function row(over: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 's1',
    title: null,
    messageCount: 0,
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
    ...over,
  }
}

describe('<ChatSessionsList />', () => {
  it('renders an empty-state hint when there are no sessions', () => {
    render(
      <ChatSessionsList
        sessions={[]}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    expect(screen.getByText(/Noch keine Unterhaltungen/i)).toBeInTheDocument()
    // "Neu" button still visible so the user has an entry point.
    expect(
      screen.getByRole('button', { name: /Neue Unterhaltung/i }),
    ).toBeInTheDocument()
  })

  it('renders sessions in the order given (newest-first contract)', () => {
    render(
      <ChatSessionsList
        sessions={[
          row({ id: 's1', title: 'Neuester' }),
          row({ id: 's2', title: 'Mittlerer' }),
          row({ id: 's3', title: 'Ältester' }),
        ]}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    const rows = screen.getAllByTestId('chat-session-row')
    expect(rows.map((r) => r.getAttribute('data-session-id'))).toEqual([
      's1',
      's2',
      's3',
    ])
  })

  it('uses a muted-italic "Neue Unterhaltung" fallback when title is null', () => {
    render(
      <ChatSessionsList
        sessions={[row({ id: 's1', title: null })]}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    const fallback = screen.getByText('Neue Unterhaltung')
    expect(fallback).toBeInTheDocument()
    // Italic styling is applied via Tailwind's `italic` class.
    expect(fallback.className).toMatch(/italic/)
  })

  it('highlights the active session row with aria-current', () => {
    render(
      <ChatSessionsList
        sessions={[row({ id: 's1' }), row({ id: 's2' })]}
        activeSessionId="s2"
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    const rows = screen.getAllByTestId('chat-session-row')
    expect(rows[0]?.getAttribute('aria-current')).toBeNull()
    expect(rows[1]?.getAttribute('aria-current')).toBe('true')
  })

  it('fires onSelect when a row is clicked', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <ChatSessionsList
        sessions={[row({ id: 's1', title: 'Eins' })]}
        onSelect={onSelect}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    await user.click(screen.getByTestId('chat-session-row'))
    expect(onSelect).toHaveBeenCalledWith('s1')
  })

  it('fires onRename (not onSelect) when the pencil is clicked', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onRename = vi.fn()
    render(
      <ChatSessionsList
        sessions={[row({ id: 's1', title: 'Eins' })]}
        onSelect={onSelect}
        onRename={onRename}
        onDelete={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Umbenennen: Eins/ }))
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('fires onDelete (not onSelect) when the trash is clicked', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    render(
      <ChatSessionsList
        sessions={[row({ id: 's1', title: 'Eins' })]}
        onSelect={onSelect}
        onRename={vi.fn()}
        onDelete={onDelete}
        onCreateNew={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Löschen: Eins/ }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('fires onCreateNew when the "Neu" button is clicked', async () => {
    const user = userEvent.setup()
    const onCreateNew = vi.fn()
    render(
      <ChatSessionsList
        sessions={[]}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreateNew={onCreateNew}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Neue Unterhaltung/ }))
    expect(onCreateNew).toHaveBeenCalledTimes(1)
  })

  it('activates a row via Enter / Space keypress (keyboard-nav a11y)', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <ChatSessionsList
        sessions={[row({ id: 's1', title: 'Eins' })]}
        onSelect={onSelect}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreateNew={vi.fn()}
      />,
    )
    const rowEl = screen.getByTestId('chat-session-row')
    rowEl.focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith('s1')
    onSelect.mockClear()
    await user.keyboard(' ')
    expect(onSelect).toHaveBeenCalledWith('s1')
  })
})
