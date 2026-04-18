import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { WochenplanStub } from './WochenplanStub'

function renderStub() {
  return render(
    <MemoryRouter initialEntries={['/wochenplan']}>
      <WochenplanStub />
    </MemoryRouter>,
  )
}

describe('<WochenplanStub />', () => {
  it('renders the serif DS7 headline "Wochenplan kommt in Phase 3"', () => {
    renderStub()
    const heading = screen.getByRole('heading', {
      level: 1,
      name: /wochenplan kommt in phase 3/i,
    })
    expect(heading).toBeInTheDocument()
    expect(heading.className).toMatch(/font-serif/)
  })

  it('renders the italic Libre-Baskerville tagline describing the Phase 3 scope', () => {
    renderStub()
    const tagline = screen.getByText(
      /rezepte planen\. einkaufsliste generieren\. saisonale vorschläge\./i,
    )
    expect(tagline).toBeInTheDocument()
    expect(tagline.className).toMatch(/italic/)
  })

  it('renders a decorative calendar illustration', () => {
    renderStub()
    // Lucide renders inline SVG; we tag it with data-testid for a
    // stable hook without depending on hidden <title> elements.
    expect(screen.getByTestId('wochenplan-stub-illustration')).toBeInTheDocument()
  })

  it('offers a "Zurück zur Startseite" link that points at /', () => {
    renderStub()
    const backLink = screen.getByRole('link', { name: /zurück zur startseite/i })
    expect(backLink).toHaveAttribute('href', '/')
  })
})
