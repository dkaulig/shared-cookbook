import { describe, expect, it } from 'vitest'
import type { MealPlanSlotDto, MealSlot } from '@shared-cookbook/shared'
import {
  MEAL_SLOTS,
  addDaysIso,
  dayKeys,
  formatGermanDate,
  formatWeekRange,
  isMonday,
  isoWeekNumber,
  nextMonday,
  prevMonday,
  slotsByDayMeal,
  toMondayIso,
} from './weekGrid'

function makeSlot(
  id: string,
  date: string,
  meal: MealSlot,
  sortOrder: number,
  overrides: Partial<MealPlanSlotDto> = {},
): MealPlanSlotDto {
  return {
    id,
    mealPlanId: 'plan-1',
    recipeId: null,
    recipeTitle: null,
    label: 'Test',
    date,
    meal,
    servings: 2,
    sortOrder,
    isCooked: false,
    parentSlotId: null,
    createdAt: '2026-04-20T00:00:00Z',
    updatedAt: '2026-04-20T00:00:00Z',
    ...overrides,
  }
}

describe('weekGrid helpers', () => {
  describe('isMonday', () => {
    it('returns true for a Monday ISO date', () => {
      expect(isMonday('2026-04-20')).toBe(true)
    })

    it('returns false for a Tuesday ISO date', () => {
      expect(isMonday('2026-04-21')).toBe(false)
    })

    it('returns false for a Sunday ISO date', () => {
      expect(isMonday('2026-04-19')).toBe(false)
    })
  })

  describe('toMondayIso', () => {
    it('returns the same date when already a Monday', () => {
      expect(toMondayIso('2026-04-20')).toBe('2026-04-20')
    })

    it('returns the preceding Monday for a mid-week date', () => {
      // Wednesday 2026-04-22 → Monday 2026-04-20
      expect(toMondayIso('2026-04-22')).toBe('2026-04-20')
    })

    it('returns the preceding Monday for a Sunday', () => {
      // Sunday 2026-04-19 → Monday 2026-04-13
      expect(toMondayIso('2026-04-19')).toBe('2026-04-13')
    })
  })

  describe('nextMonday', () => {
    it('jumps 7 days forward when input is already Monday', () => {
      expect(nextMonday('2026-04-20')).toBe('2026-04-27')
    })

    it('still jumps exactly +7 days across month boundaries', () => {
      // Monday 2026-04-27 → Monday 2026-05-04
      expect(nextMonday('2026-04-27')).toBe('2026-05-04')
    })
  })

  describe('prevMonday', () => {
    it('jumps 7 days backward when input is already Monday', () => {
      expect(prevMonday('2026-04-20')).toBe('2026-04-13')
    })

    it('still jumps exactly -7 days across year boundaries', () => {
      // Monday 2026-01-05 → Monday 2025-12-29
      expect(prevMonday('2026-01-05')).toBe('2025-12-29')
    })
  })

  describe('addDaysIso', () => {
    it('adds the requested offset and returns ISO format', () => {
      expect(addDaysIso('2026-04-20', 3)).toBe('2026-04-23')
    })

    it('supports negative offsets', () => {
      expect(addDaysIso('2026-04-20', -1)).toBe('2026-04-19')
    })
  })

  describe('dayKeys', () => {
    it('returns 7 consecutive ISO dates starting at weekStart', () => {
      const keys = dayKeys('2026-04-20')
      expect(keys).toEqual([
        '2026-04-20',
        '2026-04-21',
        '2026-04-22',
        '2026-04-23',
        '2026-04-24',
        '2026-04-25',
        '2026-04-26',
      ])
    })
  })

  describe('formatGermanDate', () => {
    it('formats an ISO date as DD.MM.YYYY', () => {
      expect(formatGermanDate('2026-04-20')).toBe('20.04.2026')
    })
  })

  describe('formatWeekRange', () => {
    it('formats a full week range as DD.MM.YYYY – DD.MM.YYYY', () => {
      expect(formatWeekRange('2026-04-20')).toBe('20.04.2026 – 26.04.2026')
    })
  })

  describe('isoWeekNumber', () => {
    it('returns the ISO week number for a Monday', () => {
      // 2026-04-20 is ISO week 17.
      expect(isoWeekNumber('2026-04-20')).toBe(17)
    })

    it('returns week 1 for early-January Mondays', () => {
      // 2026-01-05 is ISO week 2 (Jan 1 2026 is a Thursday → week 1
      // runs Dec 29 – Jan 4).
      expect(isoWeekNumber('2026-01-05')).toBe(2)
    })
  })

  describe('slotsByDayMeal', () => {
    it('buckets slots into a (date × meal) 2-dim structure and sorts by sortOrder', () => {
      const slots = [
        makeSlot('b', '2026-04-20', 'Mittag', 2),
        makeSlot('a', '2026-04-20', 'Mittag', 0),
        makeSlot('c', '2026-04-20', 'Mittag', 1),
        makeSlot('d', '2026-04-21', 'Abend', 0),
      ]
      const bucketed = slotsByDayMeal(slots, '2026-04-20')
      const mondayLunch = bucketed['2026-04-20'].Mittag
      expect(mondayLunch.map((s) => s.id)).toEqual(['a', 'c', 'b'])
      expect(bucketed['2026-04-21'].Abend.map((s) => s.id)).toEqual(['d'])
      // Untouched buckets are empty arrays, never undefined — simplifies
      // the JSX rendering loop.
      expect(bucketed['2026-04-22'].Mittag).toEqual([])
    })

    it('ignores slots outside the week window', () => {
      const slots = [
        makeSlot('inside', '2026-04-20', 'Mittag', 0),
        makeSlot('outside-before', '2026-04-13', 'Mittag', 0),
        makeSlot('outside-after', '2026-04-27', 'Mittag', 0),
      ]
      const bucketed = slotsByDayMeal(slots, '2026-04-20')
      expect(bucketed['2026-04-20'].Mittag.map((s) => s.id)).toEqual(['inside'])
      const allIds: string[] = []
      for (const date of Object.keys(bucketed)) {
        for (const meal of MEAL_SLOTS) {
          allIds.push(...bucketed[date][meal].map((s) => s.id))
        }
      }
      expect(allIds).not.toContain('outside-before')
      expect(allIds).not.toContain('outside-after')
    })

    it('produces empty buckets for every (date, meal) when no slots are supplied', () => {
      const bucketed = slotsByDayMeal([], '2026-04-20')
      for (const date of dayKeys('2026-04-20')) {
        for (const meal of MEAL_SLOTS) {
          expect(bucketed[date][meal]).toEqual([])
        }
      }
    })
  })
})
