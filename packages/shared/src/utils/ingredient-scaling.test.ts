import { describe, expect, it } from 'vitest'
import {
  STUECK_UNITS,
  scaleIngredients,
  type ScalableIngredient,
} from './ingredient-scaling.ts'

function mk(overrides: Partial<ScalableIngredient> = {}): ScalableIngredient {
  return {
    quantity: 500,
    unit: 'g',
    name: 'Mehl',
    scalable: true,
    ...overrides,
  }
}

describe('scaleIngredients — invalid inputs', () => {
  it('throws when fromServings is zero', () => {
    expect(() => scaleIngredients([mk()], 0, 4)).toThrow()
  })

  it('throws when fromServings is negative', () => {
    expect(() => scaleIngredients([mk()], -2, 4)).toThrow()
  })

  it('throws when toServings is zero', () => {
    expect(() => scaleIngredients([mk()], 4, 0)).toThrow()
  })

  it('throws when toServings is negative', () => {
    expect(() => scaleIngredients([mk()], 4, -1)).toThrow()
  })

  it('accepts fractional servings', () => {
    const [result] = scaleIngredients([mk({ quantity: 200 })], 4, 2.5)
    expect(result.quantity).toBe(125)
  })
})

describe('scaleIngredients — basic roundtrip', () => {
  it('halves quantity when scaling from 4 to 2', () => {
    const [result] = scaleIngredients([mk({ quantity: 500 })], 4, 2)
    expect(result.quantity).toBe(250)
    expect(result.unit).toBe('g')
    expect(result.displayQuantity).toBe('250 g')
  })

  it('doubles quantity when scaling from 2 to 4', () => {
    const [result] = scaleIngredients([mk({ quantity: 250 })], 2, 4)
    expect(result.quantity).toBe(500)
    expect(result.displayQuantity).toBe('500 g')
  })

  it('is stable when from equals to (factor 1)', () => {
    const [result] = scaleIngredients([mk({ quantity: 500 })], 4, 4)
    expect(result.quantity).toBe(500)
    expect(result.wasRounded).toBe(false)
  })

  it('round-trips 500 g at 4 → 250 g at 2 → 500 g at 4', () => {
    const [down] = scaleIngredients([mk({ quantity: 500 })], 4, 2)
    expect(down.quantity).toBe(250)
    const [up] = scaleIngredients(
      [mk({ quantity: down.quantity ?? 0 })],
      2,
      4,
    )
    expect(up.quantity).toBe(500)
  })

  it('preserves ingredient name through scaling', () => {
    const [result] = scaleIngredients([mk({ name: 'Zucker', quantity: 200 })], 4, 2)
    expect(result.name).toBe('Zucker')
  })

  it('exposes original quantity in originalQuantity', () => {
    const [result] = scaleIngredients([mk({ quantity: 500 })], 4, 2)
    expect(result.originalQuantity).toBe(500)
  })
})

describe('scaleIngredients — non-scalable pass-through', () => {
  it('leaves scalable:false ingredient unchanged regardless of factor', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 1, unit: 'Prise', name: 'Salz', scalable: false })],
      4,
      8,
    )
    expect(result.quantity).toBe(1)
    expect(result.unit).toBe('Prise')
    expect(result.displayQuantity).toBe('1 Prise')
    expect(result.wasRounded).toBe(false)
  })

  it('leaves quantity:null ingredient unchanged (nach Geschmack)', () => {
    const [result] = scaleIngredients(
      [{ quantity: null, unit: '', name: 'Pfeffer', scalable: false }],
      4,
      2,
    )
    expect(result.quantity).toBeNull()
    expect(result.displayQuantity).toBe('nach Geschmack')
    expect(result.wasRounded).toBe(false)
  })

  it('still passes through originalQuantity for non-scalable entries', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 2, unit: 'Prise', name: 'Salz', scalable: false })],
      4,
      8,
    )
    expect(result.originalQuantity).toBe(2)
  })
})

describe('scaleIngredients — Stück-family rounding', () => {
  it('rounds 3 Eier at 4 → 2 (from 1.5) and marks wasRounded', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 3, unit: 'Stück', name: 'Eier' })],
      4,
      2,
    )
    expect(result.quantity).toBe(2)
    expect(result.wasRounded).toBe(true)
    expect(result.displayQuantity).toBe('~2 Stück')
  })

  it('rounds 3 Eier at 4 → 5 when scaled to 6 (from 4.5) and marks wasRounded', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 3, unit: 'Stück', name: 'Eier' })],
      4,
      6,
    )
    expect(result.quantity).toBe(5)
    expect(result.wasRounded).toBe(true)
    expect(result.displayQuantity).toBe('~5 Stück')
  })

  it('does not mark wasRounded when scale lands exactly on whole number', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 4, unit: 'Stück', name: 'Eier' })],
      4,
      2,
    )
    expect(result.quantity).toBe(2)
    expect(result.wasRounded).toBe(false)
    expect(result.displayQuantity).toBe('2 Stück')
  })

  it('applies Stück-rounding to Scheibe/Zehe/Blatt/Dose/Packung/Bund as well', () => {
    for (const unit of STUECK_UNITS) {
      const [result] = scaleIngredients(
        [mk({ quantity: 3, unit, name: 'Zutat' })],
        4,
        2,
      )
      expect(result.quantity).toBe(2)
      expect(result.wasRounded).toBe(true)
    }
  })

  it('rounds to at least 1 for Stück units even when scaling tiny amounts', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 1, unit: 'Stück', name: 'Knoblauchzehe' })],
      8,
      2,
    )
    expect(result.quantity).toBe(1)
    expect(result.wasRounded).toBe(true)
  })

  it('normalizes the legacy "Stueck" spelling to Stück for rounding and display', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 3, unit: 'Stueck', name: 'Eier' })],
      4,
      2,
    )
    expect(result.quantity).toBe(2)
    expect(result.unit).toBe('Stück')
    expect(result.wasRounded).toBe(true)
  })
})

describe('scaleIngredients — decimal units', () => {
  it('rounds g quantities to 2 decimals and strips trailing zeros', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 333, unit: 'g', name: 'Mehl' })],
      4,
      3,
    )
    expect(result.quantity).toBeCloseTo(249.75, 2)
    expect(result.displayQuantity).toBe('249.75 g')
  })

  it('strips trailing zeros: 1.50 -> "1.5 TL"', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 3, unit: 'TL', name: 'Zimt' })],
      4,
      2,
    )
    expect(result.quantity).toBe(1.5)
    expect(result.displayQuantity).toBe('1.5 TL')
  })

  it('renders a whole-number decimal without ".0" suffix', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 100, unit: 'ml', name: 'Milch' })],
      2,
      4,
    )
    expect(result.quantity).toBe(200)
    expect(result.displayQuantity).toBe('200 ml')
  })

  it('produces 0.25 l display when scaling 0.5 l by half', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 0.5, unit: 'l', name: 'Milch' })],
      4,
      2,
    )
    expect(result.quantity).toBe(0.25)
    expect(result.displayQuantity).toBe('0.25 l')
  })
})

describe('scaleIngredients — Prise fallback for tiny TL/EL', () => {
  it('renders "eine Prise" when TL scale goes under 0.125', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 0.5, unit: 'TL', name: 'Muskat' })],
      4,
      1,
    )
    expect(result.displayQuantity).toBe('eine Prise')
  })

  it('renders "eine Prise" when EL scale goes under 0.125', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 0.5, unit: 'EL', name: 'Sesam' })],
      4,
      1,
    )
    expect(result.displayQuantity).toBe('eine Prise')
  })

  it('does NOT use "eine Prise" for g even when quantity is tiny', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 0.4, unit: 'g', name: 'Safran' })],
      4,
      1,
    )
    expect(result.displayQuantity).toBe('0.1 g')
  })

  it('keeps normal display when TL quantity stays >= 0.125', () => {
    const [result] = scaleIngredients(
      [mk({ quantity: 1, unit: 'TL', name: 'Salz' })],
      4,
      2,
    )
    expect(result.displayQuantity).toBe('0.5 TL')
  })
})

describe('scaleIngredients — mixed lists', () => {
  it('scales each row independently', () => {
    const rows: ScalableIngredient[] = [
      { quantity: 500, unit: 'g', name: 'Mehl', scalable: true },
      { quantity: 3, unit: 'Stück', name: 'Eier', scalable: true },
      { quantity: 1, unit: 'Prise', name: 'Salz', scalable: false },
      { quantity: null, unit: '', name: 'Pfeffer', scalable: false },
    ]

    const scaled = scaleIngredients(rows, 4, 2)

    expect(scaled).toHaveLength(4)
    expect(scaled[0].quantity).toBe(250)
    expect(scaled[1].quantity).toBe(2)
    expect(scaled[1].wasRounded).toBe(true)
    expect(scaled[2].quantity).toBe(1)
    expect(scaled[2].displayQuantity).toBe('1 Prise')
    expect(scaled[3].quantity).toBeNull()
    expect(scaled[3].displayQuantity).toBe('nach Geschmack')
  })

  it('returns an empty array for an empty input', () => {
    expect(scaleIngredients([], 4, 2)).toEqual([])
  })

  it('preserves input order', () => {
    const rows: ScalableIngredient[] = [
      { quantity: 1, unit: 'Stück', name: 'Zwiebel', scalable: true },
      { quantity: 200, unit: 'g', name: 'Reis', scalable: true },
    ]
    const scaled = scaleIngredients(rows, 2, 4)
    expect(scaled[0].name).toBe('Zwiebel')
    expect(scaled[1].name).toBe('Reis')
  })
})

describe('scaleIngredients — unitless display', () => {
  it('omits the trailing space when unit is empty and quantity is set', () => {
    const [result] = scaleIngredients(
      [{ quantity: 2, unit: '', name: 'Zwiebel', scalable: true }],
      2,
      4,
    )
    expect(result.displayQuantity).toBe('4')
  })
})
