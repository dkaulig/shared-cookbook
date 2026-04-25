import { afterEach, describe, expect, it } from 'vitest'
import type { ExtractionResult } from '@shared-cookbook/shared'
import {
  forgetChatImport,
  recallChatImport,
  stashChatImport,
} from './chatImportMemo'

const sampleResult: ExtractionResult = {
  recipe: {
    title: 'Kartoffel-Lauch-Auflauf',
    description: null,
    servings: 4,
    difficulty: 1,
    prep_minutes: 20,
    cook_minutes: 30,
    ingredients: [],
    steps: [],
    tags: ['vegan'],
    source_url: 'chat://session',
  },
  confidence: { overall: 'medium', notes: [] },
}

afterEach(() => {
  window.sessionStorage.clear()
})

describe('chatImportMemo', () => {
  it('round-trips a stashed result under a transient id', () => {
    stashChatImport('cim-1', { groupId: 'g1', result: sampleResult })
    const recalled = recallChatImport('cim-1')
    expect(recalled).not.toBeNull()
    expect(recalled!.groupId).toBe('g1')
    expect(recalled!.result.recipe.title).toBe('Kartoffel-Lauch-Auflauf')
  })

  it('returns null for an unknown id', () => {
    expect(recallChatImport('unknown')).toBeNull()
  })

  it('forgetChatImport removes the entry so subsequent recalls return null', () => {
    stashChatImport('cim-2', { groupId: 'g', result: sampleResult })
    expect(recallChatImport('cim-2')).not.toBeNull()
    forgetChatImport('cim-2')
    expect(recallChatImport('cim-2')).toBeNull()
  })

  it('never writes to localStorage (privacy — chat may contain medical info)', () => {
    stashChatImport('cim-3', { groupId: 'g', result: sampleResult })
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i) ?? ''
      expect(k).not.toMatch(/chatImport/)
    }
  })

  it('recalls null on malformed JSON without throwing', () => {
    window.sessionStorage.setItem('fk.chatImport.bad', '{not-json')
    expect(recallChatImport('bad')).toBeNull()
  })
})
