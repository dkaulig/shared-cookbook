import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { act } from '@testing-library/react'
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

// COMP-2 — helper that wraps a flat ingredient fixture in a single-
// default group so the pre-COMP-2 tests continue to pin the same
// behaviour (no sub-headers, identical rendering).
function singleDefaultGroups(
  ingredients: IngredientDto[],
): ReadonlyArray<{
  component: { id: string; position: number; label: string | null }
  label: string
  ingredients: IngredientDto[]
}> {
  return [
    {
      component: { id: 'c-default', position: 0, label: null },
      label: 'Hauptgericht',
      ingredients,
    },
  ]
}

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
      groups={singleDefaultGroups(INGREDIENTS)}
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

describe('MiseEnPlaceList — highlight state (COOK-2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // jsdom doesn't implement scrollIntoView — stub it.
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('applies a ring highlight class to the matching row', () => {
    render(
      <MiseEnPlaceList
        groups={singleDefaultGroups(INGREDIENTS)}
        defaultServings={4}
        sessionServings={4}
        checked={new Set()}
        onToggle={vi.fn()}
        highlightedIngredientId="i1"
      />,
    )
    const rows = screen.getAllByRole('checkbox')
    expect(rows[0]!.className).toMatch(/ring-2/)
    expect(rows[0]!.className).toMatch(/ring-\[hsl\(var\(--primary\)\)\]/)
  })

  it('removes the highlight class after 1.5 seconds', () => {
    render(
      <MiseEnPlaceList
        groups={singleDefaultGroups(INGREDIENTS)}
        defaultServings={4}
        sessionServings={4}
        checked={new Set()}
        onToggle={vi.fn()}
        highlightedIngredientId="i1"
      />,
    )
    const row = screen.getAllByRole('checkbox')[0]!
    expect(row.className).toMatch(/ring-2/)
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(row.className).not.toMatch(/ring-2/)
  })

  it('scrolls the highlighted row into view when the prop is set', () => {
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
    render(
      <MiseEnPlaceList
        groups={singleDefaultGroups(INGREDIENTS)}
        defaultServings={4}
        sessionServings={4}
        checked={new Set()}
        onToggle={vi.fn()}
        highlightedIngredientId="i2"
      />,
    )
    expect(scrollSpy).toHaveBeenCalled()
    const callArg = scrollSpy.mock.calls[0]![0]
    expect(callArg).toMatchObject({ block: 'nearest', behavior: 'smooth' })
  })

  it('does not crash when highlightedIngredientId is null', () => {
    expect(() =>
      render(
        <MiseEnPlaceList
          groups={singleDefaultGroups(INGREDIENTS)}
          defaultServings={4}
          sessionServings={4}
          checked={new Set()}
          onToggle={vi.fn()}
          highlightedIngredientId={null}
        />,
      ),
    ).not.toThrow()
    const rows = screen.getAllByRole('checkbox')
    rows.forEach((row) => {
      expect(row.className).not.toMatch(/ring-2/)
    })
  })
})

// ── COMP-2 — sub-header grouping ─────────────────────────────────────

describe('MiseEnPlaceList — COMP-2 grouping', () => {
  it('renders one sub-header per component in multi-component mode', () => {
    render(
      <MiseEnPlaceList
        groups={[
          {
            component: { id: 'c-sauce', position: 0, label: 'Chipotle Sauce' },
            label: 'Chipotle Sauce',
            ingredients: [
              { id: 's1', position: 0, quantity: 2, unit: 'EL', name: 'Honig', note: null, scalable: true },
            ],
          },
          {
            component: { id: 'c-main', position: 1, label: null },
            label: 'Hauptgericht',
            ingredients: [
              { id: 'm1', position: 0, quantity: 1, unit: 'Stück', name: 'Tortilla', note: null, scalable: true },
            ],
          },
        ]}
        defaultServings={2}
        sessionServings={2}
        checked={new Set()}
        onToggle={vi.fn()}
      />,
    )
    const subheaders = screen.getAllByTestId('cook-mise-en-place-subheader')
    expect(subheaders.map((h) => h.textContent)).toEqual([
      'Chipotle Sauce',
      'Hauptgericht',
    ])
  })

  it('suppresses sub-headers on a single-default group (label === null)', () => {
    render(
      <MiseEnPlaceList
        groups={singleDefaultGroups(INGREDIENTS)}
        defaultServings={4}
        sessionServings={4}
        checked={new Set()}
        onToggle={vi.fn()}
      />,
    )
    expect(
      screen.queryAllByTestId('cook-mise-en-place-subheader'),
    ).toHaveLength(0)
  })
})
