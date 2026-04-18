import { describe, expect, it } from 'vitest'
import {
  prefixLinesSelection,
  wrapSelection,
} from './markdownToolbarHelpers'

describe('wrapSelection', () => {
  it('wraps a non-empty selection with the given markers', () => {
    const { nextValue, nextSelectionStart, nextSelectionEnd } = wrapSelection(
      'Hello world',
      6,
      11,
      '**',
      '**',
    )
    expect(nextValue).toBe('Hello **world**')
    expect(nextSelectionStart).toBe(8)
    expect(nextSelectionEnd).toBe(13)
  })

  it('inserts a placeholder "Text" when the selection is empty and pre-selects it', () => {
    const { nextValue, nextSelectionStart, nextSelectionEnd } = wrapSelection(
      'abc',
      1,
      1,
      '**',
      '**',
    )
    expect(nextValue).toBe('a**Text**bc')
    expect(nextSelectionStart).toBe(3)
    expect(nextSelectionEnd).toBe(7)
  })

  it('inserts at end-of-string without index drift', () => {
    const { nextValue, nextSelectionStart, nextSelectionEnd } = wrapSelection(
      'abc',
      3,
      3,
      '*',
      '*',
    )
    expect(nextValue).toBe('abc*Text*')
    expect(nextSelectionStart).toBe(4)
    expect(nextSelectionEnd).toBe(8)
  })

  it('handles a selection that spans the entire value', () => {
    const { nextValue, nextSelectionStart, nextSelectionEnd } = wrapSelection(
      'foo',
      0,
      3,
      '*',
      '*',
    )
    expect(nextValue).toBe('*foo*')
    expect(nextSelectionStart).toBe(1)
    expect(nextSelectionEnd).toBe(4)
  })

  it('wraps a selection that crosses a newline', () => {
    const { nextValue, nextSelectionStart, nextSelectionEnd } = wrapSelection(
      'line1\nline2',
      0,
      11,
      '**',
      '**',
    )
    expect(nextValue).toBe('**line1\nline2**')
    expect(nextSelectionStart).toBe(2)
    expect(nextSelectionEnd).toBe(13)
  })

  it('works when start > end by swapping them (defensive)', () => {
    const { nextValue } = wrapSelection('abcdef', 4, 1, '*', '*')
    // Treat as selection [1,4] → "bcd"
    expect(nextValue).toBe('a*bcd*ef')
  })
})

describe('prefixLinesSelection', () => {
  it('prefixes a single line (caret only, no selection) with "- "', () => {
    // Caret sits at index 3, inside "Milch" on the only line.
    const { nextValue, nextSelectionStart, nextSelectionEnd } =
      prefixLinesSelection('Milch holen', 3, 3, '- ', {
        kind: 'unordered',
      })
    expect(nextValue).toBe('- Milch holen')
    // Caret shifted by 2 (length of "- ").
    expect(nextSelectionStart).toBe(5)
    expect(nextSelectionEnd).toBe(5)
  })

  it('prefixes every selected line with "- "', () => {
    const src = 'A\nB\nC'
    // Select from start of A to end of C.
    const { nextValue, nextSelectionStart, nextSelectionEnd } =
      prefixLinesSelection(src, 0, 5, '- ', { kind: 'unordered' })
    expect(nextValue).toBe('- A\n- B\n- C')
    expect(nextSelectionStart).toBe(0)
    // Each of 3 lines gained 2 chars → +6 total.
    expect(nextSelectionEnd).toBe(11)
  })

  it('numbers consecutive lines 1. 2. 3. for ordered lists', () => {
    const src = 'Eins\nZwei\nDrei'
    const { nextValue } = prefixLinesSelection(src, 0, src.length, '', {
      kind: 'ordered',
    })
    expect(nextValue).toBe('1. Eins\n2. Zwei\n3. Drei')
  })

  it('applies ordered prefix even when selection is caret-only on a single line', () => {
    const { nextValue, nextSelectionStart } = prefixLinesSelection(
      'nur eins',
      2,
      2,
      '',
      { kind: 'ordered' },
    )
    expect(nextValue).toBe('1. nur eins')
    // Caret shifted by length of "1. " = 3.
    expect(nextSelectionStart).toBe(5)
  })

  it('handles selection that ends exactly at a line-boundary (trailing \\n)', () => {
    const src = 'A\nB\n'
    // Selection covers "A\nB\n" — end index 4, right after the trailing newline.
    const { nextValue } = prefixLinesSelection(src, 0, 4, '- ', {
      kind: 'unordered',
    })
    // The newline after B starts a new empty line; we only prefix lines
    // that contain selected characters, not the empty tail line.
    expect(nextValue).toBe('- A\n- B\n')
  })

  it('leaves a selection that starts mid-line by prefixing that whole line', () => {
    const src = 'first\nsecond\nthird'
    // Selection starts inside "first" (index 2) and ends inside "second" (index 9).
    const { nextValue } = prefixLinesSelection(src, 2, 9, '- ', {
      kind: 'unordered',
    })
    expect(nextValue).toBe('- first\n- second\nthird')
  })

  it('keeps the entire selection visually covered after prefixing', () => {
    const src = 'a\nb\nc'
    const { nextSelectionStart, nextSelectionEnd, nextValue } =
      prefixLinesSelection(src, 0, src.length, '- ', { kind: 'unordered' })
    // Selection should now span the new value entirely.
    expect(nextSelectionStart).toBe(0)
    expect(nextSelectionEnd).toBe(nextValue.length)
  })

  it('does not mutate the original string', () => {
    const src = 'abc'
    const frozen = src
    prefixLinesSelection(src, 0, 3, '- ', { kind: 'unordered' })
    expect(src).toBe(frozen)
  })
})
