import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RecipeRevisionDetail } from '@familien-kochbuch/shared'
import { RecipeRevisionDiffModal } from './RecipeRevisionDiffModal'

const previous: RecipeRevisionDetail = {
  id: 'rev1',
  changeType: 'Created',
  changedBy: { userId: 'u1', displayName: 'Autor' },
  diffSummary: null,
  createdAt: '2026-04-15T12:00:00Z',
  snapshot: {
    title: 'Spätzle alt',
    description: 'Beschreibung A',
    defaultServings: 4,
    prepTimeMinutes: 30,
    difficulty: 1,
    sourceUrl: null,
    ingredients: [
      { position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
    ],
    steps: [{ position: 0, content: 'Mehl in eine Schüssel geben.' }],
    tagIds: [],
  },
}

const current: RecipeRevisionDetail['snapshot'] = {
  title: 'Spätzle neu',
  description: 'Beschreibung A',
  defaultServings: 4,
  prepTimeMinutes: 30,
  difficulty: 1,
  sourceUrl: null,
  ingredients: [
    { position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
    { position: 1, quantity: 100, unit: 'g', name: 'Salz', note: null, scalable: true },
  ],
  steps: [{ position: 0, content: 'Mehl gut mischen.' }],
  tagIds: [],
}

describe('RecipeRevisionDiffModal', () => {
  it('renders both snapshot titles side-by-side', () => {
    render(
      <RecipeRevisionDiffModal
        previous={previous}
        current={current}
        onClose={vi.fn()}
      />,
    )

    // Each title appears in two places: the snapshot column header AND
    // the metadata diff row that shows the change inline.
    expect(screen.getAllByText('Spätzle alt').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Spätzle neu').length).toBeGreaterThan(0)
  })

  it('marks ingredient lines that differ between snapshots', () => {
    render(
      <RecipeRevisionDiffModal
        previous={previous}
        current={current}
        onClose={vi.fn()}
      />,
    )

    // Salz only exists in the current snapshot — must be rendered with
    // the data attribute used to highlight added rows.
    const saltLine = screen.getByText(/Salz/)
    const row = saltLine.closest('[data-diff]')
    expect(row).not.toBeNull()
    expect(row?.getAttribute('data-diff')).toBe('changed')
  })

  it('marks step lines that differ between snapshots', () => {
    render(
      <RecipeRevisionDiffModal
        previous={previous}
        current={current}
        onClose={vi.fn()}
      />,
    )

    const oldStep = screen.getByText('Mehl in eine Schüssel geben.')
    expect(oldStep.closest('[data-diff]')?.getAttribute('data-diff')).toBe('changed')
    const newStep = screen.getByText('Mehl gut mischen.')
    expect(newStep.closest('[data-diff]')?.getAttribute('data-diff')).toBe('changed')
  })

  it('calls onClose when the Schließen button is clicked', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <RecipeRevisionDiffModal
        previous={previous}
        current={current}
        onClose={onClose}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Schließen/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
