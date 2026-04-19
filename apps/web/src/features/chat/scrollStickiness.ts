/**
 * Shared pure helpers for the chat's scroll-to-bottom behaviour.
 *
 * Extracted from `ChatPage` so the detection logic stays unit-testable
 * without wrestling JSDOM's scroll metrics. The ChatPage reads these
 * values from a real scroll container via a ref + onScroll listener.
 */

/**
 * Threshold in pixels below which the scrollable region is considered
 * "at the bottom". Matches the plan spec (40 px).
 *
 * Set at 40 px instead of 0 because small sub-pixel scroll offsets
 * (iOS Safari bounce, floating-point scroll positions during momentum
 * scrolling) otherwise misclassify a bottom-pinned scroll position as
 * "user scrolled up" and suppress the auto-scroll behaviour.
 */
export const SCROLL_STICKY_THRESHOLD_PX = 40

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * True when the scroll offset is within `SCROLL_STICKY_THRESHOLD_PX`
 * of the bottom edge. Use to decide whether to auto-scroll on new
 * message arrival.
 */
export function isPinnedToBottom(metrics: ScrollMetrics): boolean {
  const { scrollTop, scrollHeight, clientHeight } = metrics
  // If the content doesn't overflow the viewport yet, we're trivially
  // at the bottom — no pill, no stickiness logic needed.
  if (scrollHeight <= clientHeight) return true
  return scrollTop + clientHeight >= scrollHeight - SCROLL_STICKY_THRESHOLD_PX
}
