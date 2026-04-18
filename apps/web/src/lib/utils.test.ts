import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn()', () => {
  it('joins truthy class names with spaces', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('filters falsy values via clsx', () => {
    expect(cn('foo', false && 'hidden', null, undefined, 'bar')).toBe('foo bar')
  })

  it('merges conflicting Tailwind utilities via tailwind-merge (last wins)', () => {
    // Both classes target padding-x; tailwind-merge must keep only `px-4`.
    expect(cn('px-2', 'px-4')).toBe('px-4')
  })

  it('resolves conditional maps', () => {
    expect(cn('btn', { active: true, disabled: false })).toBe('btn active')
  })
})
