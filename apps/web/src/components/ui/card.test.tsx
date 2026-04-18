import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './card'

describe('<Card />', () => {
  it('renders a card with the default token-based surface', () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>Omas Schnitzel</CardTitle>
          <CardDescription>45 min</CardDescription>
        </CardHeader>
        <CardContent>Zutaten …</CardContent>
        <CardFooter>Gekocht</CardFooter>
      </Card>,
    )
    const card = screen.getByTestId('card')
    // Uses shadcn tokens so the Sage Modern white / sage palette flows
    // in automatically. bg-card / border must be present.
    expect(card.className).toMatch(/bg-card/)
    expect(card.className).toMatch(/border/)
    expect(card.className).toMatch(/rounded-/)
  })

  it('renders children from all subparts in document order', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Titel</CardTitle>
          <CardDescription>Untertitel</CardDescription>
        </CardHeader>
        <CardContent>Inhalt</CardContent>
        <CardFooter>Fuß</CardFooter>
      </Card>,
    )
    expect(screen.getByText('Titel')).toBeInTheDocument()
    expect(screen.getByText('Untertitel')).toBeInTheDocument()
    expect(screen.getByText('Inhalt')).toBeInTheDocument()
    expect(screen.getByText('Fuß')).toBeInTheDocument()
  })

  it('merges caller-supplied className on the root', () => {
    render(
      <Card className="extra-card" data-testid="card">
        Inhalt
      </Card>,
    )
    expect(screen.getByTestId('card').className).toMatch(/extra-card/)
  })

  it('renders CardTitle as a heading with serif-display typography', () => {
    render(<CardTitle>Rezept</CardTitle>)
    const title = screen.getByText('Rezept')
    // DS8 Sage Modern: `--font-serif` resolves to Inter, but we keep the
    // `font-serif` utility on the heading so the token mapping stays a
    // single lever.
    expect(title.className).toMatch(/font-serif/)
  })
})
