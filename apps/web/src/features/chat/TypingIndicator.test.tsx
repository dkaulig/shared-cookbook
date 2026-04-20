import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TypingIndicator } from './TypingIndicator'

describe('<TypingIndicator />', () => {
  it('renders three bouncing dots', () => {
    const { container } = render(<TypingIndicator />)
    // The dots are aria-hidden — query them by class instead.
    const dots = container.querySelectorAll('span.animate-bounce')
    expect(dots).toHaveLength(3)
  })

  it('exposes a polite-region status role with the German aria-label', () => {
    render(<TypingIndicator />)
    const status = screen.getByRole('status', {
      name: /Antwort wird geschrieben/i,
    })
    expect(status).toBeInTheDocument()
  })

  it('staggers the dot animation delays so the bounce reads as a wave', () => {
    const { container } = render(<TypingIndicator />)
    const dots = Array.from(
      container.querySelectorAll<HTMLSpanElement>('span.animate-bounce'),
    )
    expect(dots[0]?.style.animationDelay).toBe('0ms')
    expect(dots[1]?.style.animationDelay).toBe('150ms')
    expect(dots[2]?.style.animationDelay).toBe('300ms')
  })
})
