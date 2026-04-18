import type { ReactNode } from 'react'

/**
 * Minimal inline-Markdown renderer used by the step display (StepList)
 * and the step-editor preview toggle. Hand-rolled on purpose — the
 * corpus only needs **bold**, *italic*, and list prefixes (`- ` / `1. `).
 * Pulling react-markdown for that scope would be overkill.
 *
 * Security: the renderer produces React elements only. Every span of
 * source text is passed through React as a child (escaped by the
 * renderer). No `dangerouslySetInnerHTML`, no raw HTML strings.
 *
 * Malformed Markdown (e.g. an unclosed `**`) is rendered literally so
 * the user sees their own typo rather than a silent swallow or crash.
 */
export function renderInlineMarkdown(source: string): ReactNode {
  if (source === '') return null

  // Split into logical blocks: runs of `- ` lines become a single <ul>,
  // runs of `N. ` lines become a single <ol>, and every other line is a
  // plain-text block (multiple consecutive plain lines are joined with
  // <br/> so the user's line-breaks are preserved).
  const lines = source.split('\n')
  type Block =
    | { type: 'ul'; items: string[] }
    | { type: 'ol'; items: string[] }
    | { type: 'text'; lines: string[] }

  const blocks: Block[] = []
  for (const raw of lines) {
    const ulMatch = /^- (.*)$/.exec(raw)
    const olMatch = /^\d+\. (.*)$/.exec(raw)
    const last = blocks[blocks.length - 1]
    if (ulMatch) {
      if (last && last.type === 'ul') {
        last.items.push(ulMatch[1] ?? '')
      } else {
        blocks.push({ type: 'ul', items: [ulMatch[1] ?? ''] })
      }
    } else if (olMatch) {
      if (last && last.type === 'ol') {
        last.items.push(olMatch[1] ?? '')
      } else {
        blocks.push({ type: 'ol', items: [olMatch[1] ?? ''] })
      }
    } else {
      if (last && last.type === 'text') {
        last.lines.push(raw)
      } else {
        blocks.push({ type: 'text', lines: [raw] })
      }
    }
  }

  return blocks.map((block, i) => {
    if (block.type === 'ul') {
      return (
        <ul key={`ul-${i}`} className="ml-5 list-disc [&>li]:pl-0.5">
          {block.items.map((item, j) => (
            <li key={`ul-${i}-${j}`}>{renderInline(item)}</li>
          ))}
        </ul>
      )
    }
    if (block.type === 'ol') {
      return (
        <ol key={`ol-${i}`} className="ml-5 list-decimal [&>li]:pl-0.5">
          {block.items.map((item, j) => (
            <li key={`ol-${i}-${j}`}>{renderInline(item)}</li>
          ))}
        </ol>
      )
    }
    return (
      <span key={`t-${i}`}>
        {block.lines.map((line, j) => (
          <span key={`t-${i}-${j}`}>
            {renderInline(line)}
            {j < block.lines.length - 1 ? <br /> : null}
          </span>
        ))}
      </span>
    )
  })
}

/**
 * Inline renderer: handles **bold** first, then *italic* inside each
 * non-bold text run. Precedence: bold first, then italic. Triple-
 * asterisk (bold+italic) is not supported — no recipe copy in the
 * corpus needs it.
 */
function renderInline(source: string): ReactNode {
  const boldPattern = /\*\*([^*]+)\*\*/g
  const parts: Array<{ type: 'text' | 'bold'; value: string }> = []
  let cursor = 0

  for (
    let match = boldPattern.exec(source);
    match !== null;
    match = boldPattern.exec(source)
  ) {
    if (match.index > cursor) {
      parts.push({ type: 'text', value: source.slice(cursor, match.index) })
    }
    parts.push({ type: 'bold', value: match[1]! })
    cursor = match.index + match[0].length
  }
  if (cursor < source.length) {
    parts.push({ type: 'text', value: source.slice(cursor) })
  }
  if (parts.length === 0) parts.push({ type: 'text', value: source })

  return parts.map((part, i) => {
    if (part.type === 'bold') {
      return <strong key={`b-${i}`}>{part.value}</strong>
    }
    return <span key={`t-${i}`}>{renderItalics(part.value, i)}</span>
  })
}

/**
 * Inline helper (not a React component): walks the italic pattern
 * across a text run and returns an array of strings + <em> nodes.
 * Kept as a plain function so the module exports a single React
 * component surface and stays fast-refresh friendly.
 */
function renderItalics(source: string, outerKey: number): ReactNode[] {
  const italicPattern = /\*([^*\s][^*]*[^*\s]|[^*\s])\*/g
  const chunks: ReactNode[] = []
  let cursor = 0
  let idx = 0

  for (
    let match = italicPattern.exec(source);
    match !== null;
    match = italicPattern.exec(source)
  ) {
    if (match.index > cursor) {
      chunks.push(source.slice(cursor, match.index))
    }
    chunks.push(<em key={`i-${outerKey}-${idx++}`}>{match[1]!}</em>)
    cursor = match.index + match[0].length
  }
  if (cursor < source.length) {
    chunks.push(source.slice(cursor))
  }
  if (chunks.length === 0) chunks.push(source)

  return chunks
}
