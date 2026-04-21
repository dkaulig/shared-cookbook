import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { TimerChip } from './TimerChip'

describe('TimerChip — idle state', () => {
  it('renders "⏱ label" and is tappable in idle state', () => {
    render(<TimerChip label="10 Minuten" initialSeconds={600} />)
    expect(screen.getByRole('button', { name: /10 Minuten/ })).toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveTextContent('⏱')
  })
})

describe('TimerChip — running countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('click starts the timer; display shows MM:SS', () => {
    render(<TimerChip label="10 Minuten" initialSeconds={600} />)
    const btn = screen.getByRole('button')
    act(() => {
      fireEvent.click(btn)
    })
    expect(screen.getByRole('button')).toHaveTextContent('10:00')
  })

  it('decrements 1 Hz via setInterval — 3s → 09:57', () => {
    render(<TimerChip label="10 Minuten" initialSeconds={600} />)
    act(() => {
      fireEvent.click(screen.getByRole('button'))
    })
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByRole('button')).toHaveTextContent('09:57')
  })

  it('pause then resume cycles through paused / running', () => {
    render(<TimerChip label="1 Minute" initialSeconds={60} />)
    act(() => {
      fireEvent.click(screen.getByRole('button'))
    })
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.getByRole('button', { name: /pausieren/i })).toHaveTextContent('00:50')

    // Tap to pause.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /pausieren/i }))
    })
    // Advance while paused — should NOT decrement.
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(screen.getByRole('button', { name: /fortsetzen/i })).toHaveTextContent('00:50')

    // Resume.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /fortsetzen/i }))
    })
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(screen.getByRole('button', { name: /pausieren/i })).toHaveTextContent('00:48')
  })

  it('reaches 0 → enters done state + fires navigator.vibrate', () => {
    const vibrate = vi.fn().mockReturnValue(true)
    ;(navigator as unknown as { vibrate: typeof vibrate }).vibrate = vibrate

    render(<TimerChip label="3 Sekunden" initialSeconds={3} />)
    act(() => {
      fireEvent.click(screen.getByRole('button'))
    })
    act(() => {
      vi.advanceTimersByTime(3_500)
    })
    expect(screen.getByText(/Fertig/i)).toBeInTheDocument()
    expect(vibrate).toHaveBeenCalledWith(200)
  })

  it('vibrate unsupported — still transitions to done without throwing', () => {
    delete (navigator as unknown as { vibrate?: unknown }).vibrate
    render(<TimerChip label="2 Sekunden" initialSeconds={2} />)
    act(() => {
      fireEvent.click(screen.getByRole('button'))
    })
    act(() => {
      vi.advanceTimersByTime(2_500)
    })
    expect(screen.getByText(/Fertig/i)).toBeInTheDocument()
  })

  it('reset button brings done state back to idle', () => {
    render(<TimerChip label="2 Sekunden" initialSeconds={2} />)
    act(() => {
      fireEvent.click(screen.getByRole('button'))
    })
    act(() => {
      vi.advanceTimersByTime(2_500)
    })
    expect(screen.getByText(/Fertig/i)).toBeInTheDocument()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /zurücksetzen/i }))
    })
    expect(screen.getByRole('button', { name: /2 Sekunden/ })).toBeInTheDocument()
  })
})
