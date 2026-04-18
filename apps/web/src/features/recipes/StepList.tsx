import { useMemo, type ReactNode } from 'react'
import type { RecipeStepDto } from '@familien-kochbuch/shared'

export interface StepListProps {
  steps: RecipeStepDto[]
}

/**
 * DS5 numbered step cards. Cormorant-Garamond step number on the left,
 * Markdown-rendered content on the right. Visual shell mirrors
 * .step-card / .step-num in docs/mockups/warme-kueche-recipe-detail.html.
 *
 * The Markdown renderer is intentionally tiny — the mockup + existing
 * corpus only use **bold** and *italic*. Hand-rolling beats pulling in
 * react-markdown (and its remark/unified tree) for that scope. If a
 * future slice needs lists, tables, or links we swap in a real renderer
 * with a regression-test suite.
 */
export function StepList({ steps }: StepListProps) {
  const ordered = useMemo(
    () => [...steps].sort((a, b) => a.position - b.position),
    [steps],
  )

  return (
    <div className="flex flex-col gap-3">
      {ordered.map((step, index) => (
        <article
          key={step.id ?? `pos-${step.position}`}
          data-testid="step-card"
          className="grid grid-cols-[auto_1fr] gap-3.5 rounded-[18px] border border-border bg-card px-4 py-4 shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
        >
          <div
            data-testid="step-number"
            className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-primary font-serif text-[14px] font-bold leading-none text-primary-foreground"
          >
            {index + 1}
          </div>
          <div
            data-testid="step-content"
            className="text-[15px] leading-[1.55] text-foreground [&_strong]:font-semibold [&_strong]:text-[hsl(var(--primary-hover,var(--primary)))]"
          >
            {renderInlineMarkdown(step.content)}
          </div>
        </article>
      ))}
    </div>
  )
}

/**
 * Minimal inline-Markdown renderer. Handles bold runs first, then
 * splits each text run on single-asterisk italic runs. Zero deps,
 * tested in StepList.test.tsx.
 *
 * Precedence: bold first, then italic. Triple-asterisk (bold+italic)
 * is not supported — no recipe copy in the corpus needs it.
 */
function renderInlineMarkdown(source: string): ReactNode {
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
    return <TextWithItalics key={`t-${i}`} source={part.value} />
  })
}

function TextWithItalics({ source }: { source: string }) {
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
    chunks.push(<em key={`i-${idx++}`}>{match[1]!}</em>)
    cursor = match.index + match[0].length
  }
  if (cursor < source.length) {
    chunks.push(source.slice(cursor))
  }
  if (chunks.length === 0) chunks.push(source)

  return <>{chunks}</>
}
