import { describe, expect, it } from 'vitest'
import { matchIngredientsInStep } from './matchIngredientsInStep'

describe('matchIngredientsInStep', () => {
  it('returns an empty array when no ingredients match', () => {
    const result = matchIngredientsInStep(
      'Pfeffer nach Geschmack hinzufügen.',
      [{ id: 'i1', name: 'Butter' }],
    )
    expect(result).toEqual([])
  })

  it('returns a single match with correct start / end indices', () => {
    const result = matchIngredientsInStep(
      'Butter in der Pfanne schmelzen',
      [{ id: 'i1', name: 'Butter' }],
    )
    expect(result).toEqual([
      {
        matchStart: 0,
        matchEnd: 6,
        text: 'Butter',
        ingredientId: 'i1',
      },
    ])
  })

  it('returns multiple matches sorted by matchStart', () => {
    const result = matchIngredientsInStep('Mehl und Salz vermengen', [
      { id: 'i1', name: 'Salz' },
      { id: 'i2', name: 'Mehl' },
    ])
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ ingredientId: 'i2', text: 'Mehl' })
    expect(result[1]).toMatchObject({ ingredientId: 'i1', text: 'Salz' })
    expect(result[0]!.matchStart).toBeLessThan(result[1]!.matchStart)
  })

  it('matches case-insensitively but preserves the actual matched text slice', () => {
    const result = matchIngredientsInStep('butter erhitzen', [
      { id: 'i1', name: 'BUTTER' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      matchStart: 0,
      matchEnd: 6,
      text: 'butter',
      ingredientId: 'i1',
    })
  })

  it('prefers the longer ingredient when two names overlap at the same position', () => {
    // "Erdnussbutter" also contains "Butter" — we prefer the more specific name.
    const result = matchIngredientsInStep('Erdnussbutter unterrühren', [
      { id: 'b', name: 'Butter' },
      { id: 'eb', name: 'Erdnussbutter' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      ingredientId: 'eb',
      text: 'Erdnussbutter',
    })
  })

  it('respects word boundaries — "Öl" does not match inside "Schlüssel"', () => {
    const result = matchIngredientsInStep('Schlüssel nehmen', [
      { id: 'i1', name: 'Öl' },
    ])
    expect(result).toEqual([])
  })

  it('filters out names of two characters or fewer', () => {
    const result = matchIngredientsInStep('Elefanten im Raum', [
      { id: 'i1', name: 'El' },
    ])
    expect(result).toEqual([])
  })

  it('returns an empty array for empty text or zero ingredients', () => {
    expect(matchIngredientsInStep('', [{ id: 'i1', name: 'Butter' }])).toEqual([])
    expect(matchIngredientsInStep('Butter schmelzen', [])).toEqual([])
  })

  it('returns a match for every occurrence when the ingredient repeats', () => {
    const result = matchIngredientsInStep(
      'Butter schmelzen. Mehr Butter dazugeben.',
      [{ id: 'i1', name: 'Butter' }],
    )
    expect(result).toHaveLength(2)
    expect(result[0]!.matchStart).toBe(0)
    expect(result[1]!.matchStart).toBe(23)
    expect(result.every((m) => m.ingredientId === 'i1')).toBe(true)
  })

  it('matches an ingredient at the end of the string (word boundary at EOL)', () => {
    const result = matchIngredientsInStep('Am Ende hinzugeben: Butter', [
      { id: 'i1', name: 'Butter' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ matchStart: 20, matchEnd: 26 })
  })
})
