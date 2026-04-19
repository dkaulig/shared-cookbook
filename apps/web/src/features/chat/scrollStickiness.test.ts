import { describe, expect, it } from 'vitest'
import {
  SCROLL_STICKY_THRESHOLD_PX,
  isPinnedToBottom,
} from './scrollStickiness'

describe('isPinnedToBottom', () => {
  it('returns true when content does not overflow the viewport', () => {
    expect(
      isPinnedToBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 500 }),
    ).toBe(true)
  })

  it('returns true when scrolled exactly to the bottom', () => {
    expect(
      isPinnedToBottom({
        scrollTop: 500,
        scrollHeight: 1000,
        clientHeight: 500,
      }),
    ).toBe(true)
  })

  it('returns true within the threshold of the bottom', () => {
    // 500 - 30 = 470; 470 + 500 = 970; 1000 - 40 = 960. 970 > 960 → pinned.
    expect(
      isPinnedToBottom({
        scrollTop: 470,
        scrollHeight: 1000,
        clientHeight: 500,
      }),
    ).toBe(true)
  })

  it('returns false once the user has scrolled farther than the threshold', () => {
    // scrollTop=400, 400+500=900, threshold floor=960. 900 < 960 → not pinned.
    expect(
      isPinnedToBottom({
        scrollTop: 400,
        scrollHeight: 1000,
        clientHeight: 500,
      }),
    ).toBe(false)
  })

  it('threshold is 40 px (plan spec)', () => {
    expect(SCROLL_STICKY_THRESHOLD_PX).toBe(40)
  })
})
