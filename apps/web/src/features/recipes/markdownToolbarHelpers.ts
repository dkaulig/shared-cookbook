/**
 * Pure, DOM-free helpers for the Markdown toolbar on the step editor.
 *
 * Every helper takes the current textarea value + selection range and
 * returns the next value + next selection range. The component applies
 * the values by calling `onChange` and setting the textarea selection
 * in an effect. Keeping the helpers pure keeps them trivial to unit-
 * test and keeps the toolbar component thin.
 */

export interface SelectionResult {
  nextValue: string
  nextSelectionStart: number
  nextSelectionEnd: number
}

/**
 * Wrap the selected text with `before` / `after`. If the selection is
 * empty (start === end), insert `before + "Text" + after` at the caret
 * and return a selection covering the word "Text" so the user can
 * overwrite it immediately.
 */
export function wrapSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string,
): SelectionResult {
  const [s, e] = start <= end ? [start, end] : [end, start]
  if (s === e) {
    const placeholder = 'Text'
    const nextValue = value.slice(0, s) + before + placeholder + after + value.slice(s)
    const nextSelectionStart = s + before.length
    const nextSelectionEnd = nextSelectionStart + placeholder.length
    return { nextValue, nextSelectionStart, nextSelectionEnd }
  }
  const selected = value.slice(s, e)
  const nextValue = value.slice(0, s) + before + selected + after + value.slice(e)
  return {
    nextValue,
    nextSelectionStart: s + before.length,
    nextSelectionEnd: s + before.length + selected.length,
  }
}

export type ListKind = 'unordered' | 'ordered'

export interface PrefixOptions {
  kind: ListKind
}

/**
 * Prefix every selected line with a list marker:
 *   - `unordered` → "- " on each line
 *   - `ordered`   → "1. ", "2. ", "3. " … renumbered from 1
 *
 * If the selection is an empty caret, the single line under the caret
 * is prefixed. The `prefix` argument is ignored for ordered lists (the
 * helper generates the renumbered prefix itself) — it's only meaningful
 * for the unordered variant.
 *
 * Line boundaries use `\n`. A selection that ends exactly on a trailing
 * newline (end-of-string or end-of-line) does NOT consume the empty
 * line after it — we only prefix lines that contain at least one
 * selected character.
 */
export function prefixLinesSelection(
  value: string,
  start: number,
  end: number,
  prefix: string,
  options: PrefixOptions,
): SelectionResult {
  const [s, e] = start <= end ? [start, end] : [end, start]

  // Expand the range to the line boundaries that contain it.
  const lineStart = findLineStart(value, s)
  // For the end, if the selection ends exactly at a newline (`value[e-1] === '\n'`)
  // we don't want to include the next empty line. Use the character just
  // before `e` (if any) to decide which line the end belongs to.
  const endProbe = e > s && value[e - 1] === '\n' ? e - 1 : e
  const lineEnd = findLineEnd(value, endProbe)

  const before = value.slice(0, lineStart)
  const segment = value.slice(lineStart, lineEnd)
  const after = value.slice(lineEnd)

  const segLines = segment.split('\n')
  const prefixed =
    options.kind === 'ordered'
      ? segLines.map((line, i) => `${i + 1}. ${line}`)
      : segLines.map((line) => `${prefix}${line}`)
  const newSegment = prefixed.join('\n')
  const nextValue = before + newSegment + after

  // Selection extent: cover the whole new segment so the user sees the
  // full affected range highlighted. For a caret-only invocation, shift
  // the caret by the length of the first line's prefix so the user's
  // typing position stays on the same character they were on.
  if (s === e) {
    const firstPrefix =
      options.kind === 'ordered' ? '1. ' : prefix
    const caret = s + firstPrefix.length
    return {
      nextValue,
      nextSelectionStart: caret,
      nextSelectionEnd: caret,
    }
  }

  return {
    nextValue,
    nextSelectionStart: lineStart,
    nextSelectionEnd: lineStart + newSegment.length,
  }
}

function findLineStart(value: string, index: number): number {
  const prevNewline = value.lastIndexOf('\n', index - 1)
  return prevNewline === -1 ? 0 : prevNewline + 1
}

function findLineEnd(value: string, index: number): number {
  const nextNewline = value.indexOf('\n', index)
  return nextNewline === -1 ? value.length : nextNewline
}
