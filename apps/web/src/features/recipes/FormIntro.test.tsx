import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FormIntro } from './FormIntro'

describe('<FormIntro />', () => {
  it('renders the serif h1 "Neues Rezept" in create mode', () => {
    render(<FormIntro mode="create" groupName="Familie Kaulig" />)
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent('Neues Rezept')
  })

  it('renders the serif h1 "Rezept bearbeiten" in edit mode', () => {
    render(<FormIntro mode="edit" groupName="Familie Kaulig" />)
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent('Rezept bearbeiten')
  })

  it('renders the italic tagline with a Libre-Baskerville serif body class', () => {
    const { container } = render(<FormIntro mode="create" groupName="Familie Kaulig" />)
    // The tagline is a <p> that uses the DS1 font-serif-body family and is
    // wrapped in <em> (or similar) for the italic styling.
    const tagline = container.querySelector('p')
    expect(tagline).not.toBeNull()
    expect(tagline?.className).toMatch(/serif-body|italic/)
    expect(tagline?.textContent ?? '').toMatch(/Zutaten und Schritte/i)
  })

  it('renders the target-group pill with the group name', () => {
    render(<FormIntro mode="create" groupName="Familie Kaulig" />)
    expect(screen.getByText(/Gruppe: Familie Kaulig/i)).toBeInTheDocument()
  })

  it('falls back to a placeholder dash when groupName is undefined', () => {
    render(<FormIntro mode="create" groupName={undefined} />)
    // We prefer showing the "loading" placeholder over an empty pill.
    expect(screen.getByText(/Gruppe: …/)).toBeInTheDocument()
  })
})
