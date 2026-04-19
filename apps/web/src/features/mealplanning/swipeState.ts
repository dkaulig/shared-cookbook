/**
 * Pure helpers for the slot-card swipe-to-delete gesture (plan §P3-10).
 *
 * The component layer is responsible for wiring touch events; this
 * module only owns the maths so the threshold logic is unit-testable
 * without touching jsdom's flaky `TouchEvent` simulation.
 *
 * Convention:
 *   - Negative offset = card slid to the left (revealing the action button on the right).
 *   - Positive offset = right-swipe, clamped to 0 (we don't reveal anything in that direction).
 *
 * The reveal threshold is 60 % of the card's measured pixel width. The
 * caller passes `cardWidth` so the helper can stay framework-agnostic
 * (no `getBoundingClientRect` in here — keeps the test pure).
 */

export const REVEAL_THRESHOLD = 0.6

export interface SwipeInput {
  startX: number
  currentX: number
}

export interface ComputeOffsetOptions {
  /** Maximum pixel-distance the card can slide. Defaults to a sensible upper bound. */
  cardWidth?: number
}

export function computeOffset(
  input: SwipeInput,
  options: ComputeOffsetOptions = {},
): number {
  const delta = input.currentX - input.startX
  // Right-swipes don't reveal anything — clamp to 0 so the card snaps
  // back into place when the user drags the wrong way.
  if (delta >= 0) return 0
  const cap = options.cardWidth ?? Number.POSITIVE_INFINITY
  // `delta` is negative; cap by `-cardWidth` so the card doesn't run
  // past the screen edge.
  if (delta < -cap) return -cap
  return delta
}

export interface RevealInput {
  offset: number
  cardWidth: number
}

/**
 * After the user releases their finger, did they drag far enough to
 * commit to the reveal? Anything below the threshold snaps back; at-or-
 * past it stays revealed until the user taps "Löschen" or swipes
 * back / taps outside.
 */
export function shouldRevealAfterRelease(input: RevealInput): boolean {
  if (input.cardWidth <= 0) return false
  if (input.offset >= 0) return false
  return Math.abs(input.offset) >= input.cardWidth * REVEAL_THRESHOLD
}

/**
 * Mid-swipe predicate — used by the component layer to decide whether
 * the action button is currently visible. Same threshold as the
 * release-decision so the visual + commit boundary stays consistent.
 */
export function isRevealed(input: RevealInput): boolean {
  return shouldRevealAfterRelease(input)
}
