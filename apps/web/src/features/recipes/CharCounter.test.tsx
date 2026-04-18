import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CharCounter } from './CharCounter'

describe('<CharCounter />', () => {
  it('renders the count as "X / Y"', () => {
    render(<CharCounter value="hello" max={100} />)
    expect(screen.getByText(/5 \/ 100/)).toBeInTheDocument()
  })

  it('uses the neutral style when well under the limit', () => {
    const { container } = render(<CharCounter value="x" max={100} />)
    const el = container.firstElementChild as HTMLElement
    expect(el.className).not.toMatch(/text-(?:amber|red)/)
  })

  it('turns amber once the value crosses the 80% warn threshold', () => {
    const { container } = render(<CharCounter value={'x'.repeat(85)} max={100} />)
    const el = container.firstElementChild as HTMLElement
    expect(el.className).toMatch(/amber/)
  })

  it('turns red once the value reaches the hard limit', () => {
    const { container } = render(<CharCounter value={'x'.repeat(100)} max={100} />)
    const el = container.firstElementChild as HTMLElement
    expect(el.className).toMatch(/(?:red|destructive)/)
  })

  it('counts by string length, not bytes — unicode code points count as 1', () => {
    render(<CharCounter value="äöüß" max={10} />)
    expect(screen.getByText(/4 \/ 10/)).toBeInTheDocument()
  })
})
