import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WochenplanStub } from './WochenplanStub'

describe('<WochenplanStub />', () => {
  it('renders the serif-typeset heading "Wochenplan"', () => {
    render(<WochenplanStub />)
    const heading = screen.getByRole('heading', { level: 1, name: /wochenplan/i })
    expect(heading).toBeInTheDocument()
    expect(heading.className).toMatch(/font-serif/)
  })

  it('tells the user the feature is planned for Phase 3', () => {
    render(<WochenplanStub />)
    expect(screen.getByText(/bald verfügbar/i)).toBeInTheDocument()
    expect(screen.getByText(/phase 3/i)).toBeInTheDocument()
  })
})
