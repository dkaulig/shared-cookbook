import { describe, expect, it } from 'vitest'
import { tokeniseStepText } from './tokeniseStepText'

describe('tokeniseStepText', () => {
  it('returns a single text token when there are no matches', () => {
    const result = tokeniseStepText('Nach Geschmack würzen.', [])
    expect(result).toEqual([{ type: 'text', value: 'Nach Geschmack würzen.' }])
  })

  it('emits text + timer + text + ingredient + text for a mixed step', () => {
    const result = tokeniseStepText(
      'Butter schmelzen, 5 Minuten ziehen lassen.',
      [{ id: 'i1', name: 'Butter' }],
    )
    // Expected: [ingredient Butter, text " schmelzen, ", timer "5 Minuten", text " ziehen lassen."]
    expect(result).toHaveLength(4)
    expect(result[0]).toMatchObject({ type: 'ingredient', text: 'Butter', ingredientId: 'i1' })
    expect(result[1]).toMatchObject({ type: 'text', value: ' schmelzen, ' })
    expect(result[2]).toMatchObject({ type: 'timer', label: '5 Minuten', seconds: 300 })
    expect(result[3]).toMatchObject({ type: 'text', value: ' ziehen lassen.' })
  })

  it('prefers the timer when a timer and an ingredient overlap at the same position', () => {
    // Contrived but real: ingredient called "5 Minuten Reis" (imagine a
    // branded item). The timer regex matches "5 Minuten" inside it. We
    // want the timer to win.
    const result = tokeniseStepText('5 Minuten Reis garen', [
      { id: 'i1', name: '5 Minuten Reis' },
    ])
    const timers = result.filter((t) => t.type === 'timer')
    const ingredients = result.filter((t) => t.type === 'ingredient')
    expect(timers).toHaveLength(1)
    expect(ingredients).toHaveLength(0)
  })

  it('produces no empty text token between two adjacent matches', () => {
    // Two ingredients back-to-back with only a single space. We expect
    // [ingredient, text " ", ingredient] — NOT [ingredient, text "",
    // text " ", ingredient] or any zero-length gap token.
    const result = tokeniseStepText('Butter Zucker verrühren', [
      { id: 'i1', name: 'Butter' },
      { id: 'i2', name: 'Zucker' },
    ])
    expect(result).toHaveLength(4)
    expect(result[0]).toMatchObject({ type: 'ingredient', ingredientId: 'i1' })
    expect(result[1]).toMatchObject({ type: 'text', value: ' ' })
    expect(result[2]).toMatchObject({ type: 'ingredient', ingredientId: 'i2' })
    expect(result[3]).toMatchObject({ type: 'text', value: ' verrühren' })
  })

  it('does not emit a leading empty text token when a match is at the start', () => {
    const result = tokeniseStepText('Butter schmelzen.', [
      { id: 'i1', name: 'Butter' },
    ])
    expect(result[0]).toMatchObject({ type: 'ingredient' })
  })

  it('does not emit a trailing empty text token when a match is at the end', () => {
    const result = tokeniseStepText('Schmelzen: Butter', [
      { id: 'i1', name: 'Butter' },
    ])
    expect(result[result.length - 1]).toMatchObject({ type: 'ingredient' })
  })

  it('assigns stable keys per token', () => {
    const result = tokeniseStepText('Butter 5 Minuten ziehen.', [
      { id: 'i1', name: 'Butter' },
    ])
    const ingredientToken = result.find((t) => t.type === 'ingredient')!
    const timerToken = result.find((t) => t.type === 'timer')!
    expect(ingredientToken).toMatchObject({
      type: 'ingredient',
      key: 'ingredient:0:i1',
    })
    expect(timerToken).toMatchObject({
      type: 'timer',
    })
    // Timer key must include the start offset so it stays stable even
    // when identical timer tokens recur in the same step.
    if (timerToken.type === 'timer') {
      expect(timerToken.key.startsWith('timer:7:')).toBe(true)
    }
  })
})
