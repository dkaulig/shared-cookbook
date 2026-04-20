import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MealPlanSlotDto, MealSlot } from '@familien-kochbuch/shared'
import { MobileDayStack } from './MobileDayStack'
import { defaultOpenDays } from './mobileDayStackHelpers'

const PLAN_ID = '11111111-1111-1111-1111-111111111111'
const WEEK_START = '2026-04-20' // Monday

// Pin "today" to the Sunday before WEEK_START so `defaultOpenDays` always
// falls back to Monday-only regardless of the real clock. Without this
// the suite is flaky whenever CI (or a dev machine) runs on a date that
// lands inside the WEEK_START..+6d fixture window — then "tomorrow"
// defaults open and the "collapsed other days" assertions break.
// Using vi.setSystemTime without useFakeTimers so userEvent's real-timer
// queue keeps working.
beforeAll(() => {
  vi.setSystemTime(new Date('2026-04-19T12:00:00Z'))
})
afterAll(() => {
  vi.useRealTimers()
})

function makeSlot(
  id: string,
  overrides: Partial<MealPlanSlotDto> = {},
): MealPlanSlotDto {
  return {
    id,
    mealPlanId: PLAN_ID,
    recipeId: null,
    label: `Slot ${id}`,
    date: WEEK_START,
    meal: 'Mittag',
    servings: 2,
    sortOrder: 0,
    isCooked: false,
    parentSlotId: null,
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
    ...overrides,
  }
}

function emptyBuckets(): Record<MealSlot, MealPlanSlotDto[]> {
  return { Frühstück: [], Mittag: [], Abend: [], Snack: [] }
}

function bucketsForOneDay(slots: MealPlanSlotDto[]): Record<MealSlot, MealPlanSlotDto[]> {
  const buckets = emptyBuckets()
  for (const slot of slots) {
    buckets[slot.meal] = [...buckets[slot.meal], slot]
  }
  return buckets
}

function noop() {}

describe('<MobileDayStack />', () => {
  it('renders a section per day in the week', () => {
    render(
      <MobileDayStack
        weekStart={WEEK_START}
        bucketsByDay={{}}
        onAdd={noop}
        onEdit={noop}
        onDelete={noop}
        onReorder={noop}
        onToggleCooked={noop}
      />,
    )

    // 7 collapsible day toggles, one per weekday.
    const toggles = screen.getAllByTestId(/^mobile-day-toggle-/)
    expect(toggles).toHaveLength(7)
  })

  it('starts with the first day expanded by default for fast access', () => {
    // Real "today" is 2026-04-19 (Sunday) — outside this week range
    // [2026-04-20..2026-04-26]. `defaultOpenDays` falls back to Monday,
    // so Monday's slot is visible and Tuesday stays collapsed.
    const slots = [makeSlot('s1', { label: 'Spaghetti' })]
    render(
      <MobileDayStack
        weekStart={WEEK_START}
        bucketsByDay={{ [WEEK_START]: bucketsForOneDay(slots) }}
        onAdd={noop}
        onEdit={noop}
        onDelete={noop}
        onReorder={noop}
        onToggleCooked={noop}
      />,
    )

    // Monday's slot is visible because Monday is auto-expanded.
    expect(screen.getByText('Spaghetti')).toBeInTheDocument()
    // Other days collapsed → their slots stay hidden behind the toggle.
    const tuesdayToggle = screen.getByTestId('mobile-day-toggle-2026-04-21')
    expect(tuesdayToggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('toggles a day open and closed when its header is clicked', async () => {
    const user = userEvent.setup()
    const tuesdaySlot = makeSlot('s1', {
      date: '2026-04-21',
      label: 'Linsencurry',
    })
    render(
      <MobileDayStack
        weekStart={WEEK_START}
        bucketsByDay={{ '2026-04-21': bucketsForOneDay([tuesdaySlot]) }}
        onAdd={noop}
        onEdit={noop}
        onDelete={noop}
        onReorder={noop}
        onToggleCooked={noop}
      />,
    )

    // Tuesday starts collapsed → slot text not visible.
    expect(screen.queryByText('Linsencurry')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('mobile-day-toggle-2026-04-21'))
    expect(screen.getByText('Linsencurry')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-day-toggle-2026-04-21')).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    await user.click(screen.getByTestId('mobile-day-toggle-2026-04-21'))
    expect(screen.queryByText('Linsencurry')).not.toBeInTheDocument()
  })

  it('renders the German weekday label and ISO short-date in the header', () => {
    render(
      <MobileDayStack
        weekStart={WEEK_START}
        bucketsByDay={{}}
        onAdd={noop}
        onEdit={noop}
        onDelete={noop}
        onReorder={noop}
        onToggleCooked={noop}
      />,
    )

    const monday = screen.getByTestId('mobile-day-toggle-2026-04-20')
    expect(monday).toHaveTextContent('Montag')
    expect(monday).toHaveTextContent('20.04.2026')
  })

  it('fires onAdd with the meal-slot when an empty cell add-button is tapped', async () => {
    const onAdd = vi.fn()
    const user = userEvent.setup()
    render(
      <MobileDayStack
        weekStart={WEEK_START}
        bucketsByDay={{}}
        onAdd={onAdd}
        onEdit={noop}
        onDelete={noop}
        onReorder={noop}
        onToggleCooked={noop}
      />,
    )

    // Monday is open by default — its 4 add-buttons should be reachable.
    const addButtons = screen.getAllByLabelText(/Gericht hinzufügen/i)
    expect(addButtons.length).toBeGreaterThanOrEqual(4)
    await user.click(addButtons[0])

    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0]?.[0]).toBe(WEEK_START)
    // Add buttons in DOM order start with Frühstück (the first meal slot).
    expect(onAdd.mock.calls[0]?.[1]).toBe('Frühstück')
  })

  it('renders the slot-count chip on each day header', () => {
    const monSlots = [
      makeSlot('s1', { date: WEEK_START, meal: 'Mittag' }),
      makeSlot('s2', { date: WEEK_START, meal: 'Abend' }),
    ]
    render(
      <MobileDayStack
        weekStart={WEEK_START}
        bucketsByDay={{ [WEEK_START]: bucketsForOneDay(monSlots) }}
        onAdd={noop}
        onEdit={noop}
        onDelete={noop}
        onReorder={noop}
        onToggleCooked={noop}
      />,
    )

    const monday = screen.getByTestId('mobile-day-toggle-2026-04-20')
    expect(monday).toHaveTextContent(/2 Gerichte/)
  })
})

describe('defaultOpenDays', () => {
  const WEEK = '2026-04-20' // Monday

  it('opens today + the next day when today is inside the week', () => {
    // Wednesday 2026-04-22 → open Wed + Thu.
    const open = defaultOpenDays(WEEK, '2026-04-22')
    expect(Array.from(open).sort()).toEqual(['2026-04-22', '2026-04-23'])
  })

  it('falls back to Monday when today is outside the week', () => {
    // Historical week: today is much later than week-end.
    const open = defaultOpenDays(WEEK, '2026-05-15')
    expect(Array.from(open)).toEqual(['2026-04-20'])
  })

  it('opens only Sunday when today is the last day of the week (no wrap into next week)', () => {
    // Sunday 2026-04-26 is index 6; there's no day[7] to open.
    const open = defaultOpenDays(WEEK, '2026-04-26')
    expect(Array.from(open)).toEqual(['2026-04-26'])
  })
})
