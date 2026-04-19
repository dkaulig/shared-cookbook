import { describe, expect, it } from 'vitest'
import {
  REVEAL_THRESHOLD,
  computeOffset,
  isRevealed,
  shouldRevealAfterRelease,
} from './swipeState'

describe('swipeState helpers', () => {
  describe('computeOffset', () => {
    it('returns a non-positive number for a left-swipe (current < start)', () => {
      // start=200, current=140 → 60-px left swipe → offset -60
      expect(computeOffset({ startX: 200, currentX: 140 })).toBe(-60)
    })

    it('clamps right-swipes (current > start) to zero — no rightward overshoot', () => {
      expect(computeOffset({ startX: 100, currentX: 140 })).toBe(0)
    })

    it('caps the maximum left offset at minus the card width', () => {
      // If the user keeps dragging far past the card width, the offset
      // must not run away to -∞ — it caps so the action button stays
      // pinned to the right edge.
      expect(
        computeOffset({ startX: 300, currentX: 50 }, { cardWidth: 200 }),
      ).toBe(-200)
    })

    it('returns 0 when start and current are identical (no drag yet)', () => {
      expect(computeOffset({ startX: 100, currentX: 100 })).toBe(0)
    })
  })

  describe('shouldRevealAfterRelease', () => {
    it('returns true when the offset crosses the 60% reveal threshold', () => {
      // Card 200px → threshold 120px. Offset -125 → reveal.
      expect(shouldRevealAfterRelease({ offset: -125, cardWidth: 200 })).toBe(
        true,
      )
    })

    it('returns false when the offset is below the threshold', () => {
      expect(shouldRevealAfterRelease({ offset: -60, cardWidth: 200 })).toBe(
        false,
      )
    })

    it('returns false for any non-negative offset (no swipe / right-swipe)', () => {
      expect(shouldRevealAfterRelease({ offset: 0, cardWidth: 200 })).toBe(false)
      expect(shouldRevealAfterRelease({ offset: 10, cardWidth: 200 })).toBe(
        false,
      )
    })

    it('treats a 0-width card as un-revealable (avoids divide-by-zero)', () => {
      expect(shouldRevealAfterRelease({ offset: -50, cardWidth: 0 })).toBe(false)
    })
  })

  describe('isRevealed', () => {
    it('considers the card revealed when offset is at-or-past the threshold', () => {
      expect(isRevealed({ offset: -120, cardWidth: 200 })).toBe(true)
      expect(isRevealed({ offset: -150, cardWidth: 200 })).toBe(true)
    })

    it('considers the card hidden when offset is below the threshold', () => {
      expect(isRevealed({ offset: -100, cardWidth: 200 })).toBe(false)
      expect(isRevealed({ offset: 0, cardWidth: 200 })).toBe(false)
    })
  })

  it('exports REVEAL_THRESHOLD = 0.6 (60% of card width)', () => {
    // Locked so future tweaks have to update tests deliberately — the
    // 60% threshold mirrors the spec from §P3-10.
    expect(REVEAL_THRESHOLD).toBe(0.6)
  })
})
