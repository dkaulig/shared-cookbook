import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { RecipeStepDto } from '@shared-cookbook/shared'
import { StepList } from './StepList'

const STEPS: RecipeStepDto[] = [
  { id: 's1', position: 0, content: 'Kartoffeln schälen und kochen.' },
  { id: 's2', position: 1, content: 'Schnitzel **dünn klopfen**.' },
  { id: 's3', position: 2, content: 'Mit *Muskat* abschmecken.' },
]

describe('StepList', () => {
  it('renders one card per step', () => {
    render(<StepList steps={STEPS} />)
    expect(screen.getByText('Kartoffeln schälen und kochen.')).toBeInTheDocument()
    expect(screen.getAllByTestId('step-card')).toHaveLength(3)
  })

  it('renders 1-based step numbers derived from position order', () => {
    render(<StepList steps={STEPS} />)
    const nums = screen.getAllByTestId('step-number').map((n) => n.textContent)
    expect(nums).toEqual(['1', '2', '3'])
  })

  it('orders steps by position even if the array is shuffled', () => {
    const shuffled = [STEPS[2]!, STEPS[0]!, STEPS[1]!]
    render(<StepList steps={shuffled} />)
    const contents = screen.getAllByTestId('step-content').map((c) => c.textContent)
    expect(contents?.[0]).toContain('Kartoffeln')
    expect(contents?.[2]).toContain('Muskat')
  })

  it('renders **bold** markdown segments inside a <strong> tag', () => {
    render(<StepList steps={STEPS} />)
    const strong = screen.getByText(/dünn klopfen/)
    expect(strong.tagName.toLowerCase()).toBe('strong')
  })

  it('renders *italic* markdown segments inside an <em> tag', () => {
    render(<StepList steps={STEPS} />)
    const em = screen.getByText('Muskat')
    expect(em.tagName.toLowerCase()).toBe('em')
  })

  it('renders empty-list gracefully (no rows, no error)', () => {
    render(<StepList steps={[]} />)
    expect(screen.queryByTestId('step-card')).not.toBeInTheDocument()
  })
})
