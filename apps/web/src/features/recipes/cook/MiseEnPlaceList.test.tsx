import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { IngredientDto } from '@familien-kochbuch/shared'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MiseEnPlaceList } from './MiseEnPlaceList'

const INGREDIENTS: IngredientDto[] = [
  { id: 'i1', position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
  { id: 'i2', position: 1, quantity: 2, unit: 'Stück', name: 'Eier', note: null, scalable: true },
  {
    id: 'i3',
    position: 2,
    quantity: null,
    unit: '',
    name: 'Salz',
    note: null,
    scalable: false,
  },
]

function Harness({
  sessionServings,
  onToggle,
}: {
  sessionServings: number
  onToggle?: (key: string) => void
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set())
  function toggle(key: string) {
    onToggle?.(key)
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  return (
    <MiseEnPlaceList
      ingredients={INGREDIENTS}
      defaultServings={4}
      sessionServings={sessionServings}
      checked={checked}
      onToggle={toggle}
    />
  )
}

describe('MiseEnPlaceList', () => {
  it('renders one row per ingredient scaled to session portions', () => {
    render(<Harness sessionServings={4} />)
    const rows = screen.getAllByRole('checkbox')
    expect(rows).toHaveLength(3)
    // Scaled at 1× → 500 g mehl, 2 Stück Eier (pass-through), "nach
    // Geschmack" for Salz.
    expect(screen.getByText('500 g')).toBeInTheDocument()
    expect(screen.getByText('Mehl')).toBeInTheDocument()
    expect(screen.getByText('Eier')).toBeInTheDocument()
    expect(screen.getByText(/nach Geschmack/i)).toBeInTheDocument()
  })

  it('rescales displayed quantities when sessionServings doubles', () => {
    const { rerender } = render(<Harness sessionServings={4} />)
    expect(screen.getByText('500 g')).toBeInTheDocument()
    rerender(<Harness sessionServings={8} />)
    expect(screen.getByText('1000 g')).toBeInTheDocument()
  })

  it('toggles aria-checked on tap and fires the onToggle callback', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(<Harness sessionServings={4} onToggle={handler} />)
    const first = screen.getAllByRole('checkbox')[0]!
    expect(first).toHaveAttribute('aria-checked', 'false')
    await user.click(first)
    expect(first).toHaveAttribute('aria-checked', 'true')
    expect(handler).toHaveBeenCalledWith('i1')
  })

  it('reserves a min-h on rows so check-state does not cause layout shift', () => {
    render(<Harness sessionServings={4} />)
    const rows = screen.getAllByRole('checkbox')
    rows.forEach((row) => {
      // Tailwind class — row guarantees a tap-target height regardless
      // of check state.
      expect(row.className).toMatch(/min-h-\[72px\]/)
    })
  })
})
