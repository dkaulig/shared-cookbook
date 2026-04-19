import { describe, expect, it } from 'vitest'
import {
  CHAT_HARD_CAP,
  CHAT_WARN_AT,
  classifyTurnCap,
} from './turnCap'

describe('classifyTurnCap', () => {
  it('is ok below the warn threshold', () => {
    expect(classifyTurnCap(0)).toBe('ok')
    expect(classifyTurnCap(10)).toBe('ok')
    expect(classifyTurnCap(CHAT_WARN_AT - 1)).toBe('ok')
  })

  it('switches to warn at 25 turns (plan spec)', () => {
    expect(CHAT_WARN_AT).toBe(25)
    expect(classifyTurnCap(CHAT_WARN_AT)).toBe('warn')
    expect(classifyTurnCap(CHAT_HARD_CAP - 1)).toBe('warn')
  })

  it('blocks at 30 turns (matches backend 413 cap)', () => {
    expect(CHAT_HARD_CAP).toBe(30)
    expect(classifyTurnCap(CHAT_HARD_CAP)).toBe('blocked')
    expect(classifyTurnCap(50)).toBe('blocked')
  })
})
