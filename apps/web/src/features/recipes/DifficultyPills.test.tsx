import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DifficultyPills } from './DifficultyPills'

describe('<DifficultyPills />', () => {
  it('renders the three German difficulty labels', () => {
    render(<DifficultyPills value={1} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: /Einfach/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Mittel/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Aufwendig/ })).toBeInTheDocument()
  })

  it('marks the button that matches value with aria-pressed="true" and the others with "false"', () => {
    render(<DifficultyPills value={2} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: /Einfach/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /Mittel/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Aufwendig/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('fires onChange with the selected level when a pill is tapped', async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    render(<DifficultyPills value={1} onChange={handleChange} />)
    await user.click(screen.getByRole('button', { name: /Aufwendig/ }))
    expect(handleChange).toHaveBeenCalledWith(3)
  })

  it('renders one dot for Einfach, two for Mittel, three for Aufwendig', () => {
    render(<DifficultyPills value={1} onChange={() => {}} />)
    const einfach = screen.getByRole('button', { name: /Einfach/ })
    const mittel = screen.getByRole('button', { name: /Mittel/ })
    const aufwendig = screen.getByRole('button', { name: /Aufwendig/ })
    expect(einfach.querySelectorAll('[data-dot]')).toHaveLength(1)
    expect(mittel.querySelectorAll('[data-dot]')).toHaveLength(2)
    expect(aufwendig.querySelectorAll('[data-dot]')).toHaveLength(3)
  })

  it('does not refire onChange when the currently selected pill is tapped again', async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    render(<DifficultyPills value={2} onChange={handleChange} />)
    await user.click(screen.getByRole('button', { name: /Mittel/ }))
    expect(handleChange).not.toHaveBeenCalled()
  })
})
