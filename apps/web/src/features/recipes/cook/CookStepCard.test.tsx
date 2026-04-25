import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RecipeStepDto } from '@shared-cookbook/shared'
import { CookStepCard } from './CookStepCard'
import { CookBottomBar } from './CookBottomBar'
import type { TimerChipState } from './TimerChip'

const STEP: RecipeStepDto = {
  id: 's1',
  position: 0,
  content: 'Mehl in eine Schüssel geben.',
}

/** Shared default props for the now-required wiring. */
const DEFAULTS = {
  timerStates: new Map<string, TimerChipState>(),
  onTimerStateChange: () => {},
  ingredients: [] as Array<{ id: string; name: string }>,
  onIngredientActivate: () => {},
}

describe('CookStepCard', () => {
  it('renders the step number, total + step text', () => {
    render(
      <CookStepCard step={STEP} stepNumber={2} totalSteps={5} {...DEFAULTS} />,
    )
    expect(screen.getByText(/Schritt 2 von 5/i)).toBeInTheDocument()
    expect(screen.getByText('Mehl in eine Schüssel geben.')).toBeInTheDocument()
  })

  it('uses large typography on the step body (≥22px)', () => {
    render(
      <CookStepCard step={STEP} stepNumber={1} totalSteps={3} {...DEFAULTS} />,
    )
    const body = screen.getByTestId('cook-step-content')
    // 22px at md breakpoint and up; we assert the Tailwind class is
    // present rather than parsing computed styles (jsdom has no layout
    // engine).
    expect(body.className).toMatch(/text-\[22px\]/)
  })
})

describe('CookStepCard — bottom-bar integration', () => {
  it('disables the back button on step 1', () => {
    const onBack = vi.fn()
    const onNext = vi.fn()
    render(
      <CookBottomBar
        backDisabled={true}
        nextLabel="Weiter"
        nextIsFinish={false}
        onBack={onBack}
        onNext={onNext}
      />,
    )
    expect(screen.getByRole('button', { name: /Zurück/i })).toBeDisabled()
  })

  it('changes the next-button label to "Fertig" on the last step', () => {
    render(
      <CookBottomBar
        backDisabled={false}
        nextLabel="Fertig"
        nextIsFinish={true}
        onBack={vi.fn()}
        onNext={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /^Fertig$/i })).toBeInTheDocument()
  })

  it('fires the next handler on click', async () => {
    const user = userEvent.setup()
    const onNext = vi.fn()
    render(
      <CookBottomBar
        backDisabled={false}
        nextLabel="Weiter"
        nextIsFinish={false}
        onBack={vi.fn()}
        onNext={onNext}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Weiter/i }))
    expect(onNext).toHaveBeenCalledTimes(1)
  })
})

describe('CookStepCard — inline timer chips', () => {
  it('renders a TimerChip for "5-7 Minuten köcheln"', () => {
    render(
      <CookStepCard
        step={{ id: 's2', position: 1, content: '5-7 Minuten köcheln lassen.' }}
        stepNumber={2}
        totalSteps={3}
        {...DEFAULTS}
      />,
    )
    expect(screen.getByTestId('timer-chip')).toBeInTheDocument()
    // Chip label echoes the upper bound form from the regex match.
    expect(screen.getByRole('button', { name: /5-7 Minuten/ })).toBeInTheDocument()
  })

  it('does not render a chip when there is no numeric time expression', () => {
    render(
      <CookStepCard
        step={{ id: 's3', position: 2, content: 'Nach Geschmack würzen.' }}
        stepNumber={3}
        totalSteps={3}
        {...DEFAULTS}
      />,
    )
    expect(screen.queryByTestId('timer-chip')).not.toBeInTheDocument()
  })
})

describe('CookStepCard — ingredient chips (COOK-2)', () => {
  it('renders a TimerChip + IngredientChip for a step containing both', () => {
    const onActivate = vi.fn()
    render(
      <CookStepCard
        step={{
          id: 's2',
          position: 1,
          content: 'Butter schmelzen, 5 Minuten ziehen lassen.',
        }}
        stepNumber={2}
        totalSteps={3}
        timerStates={DEFAULTS.timerStates}
        onTimerStateChange={DEFAULTS.onTimerStateChange}
        ingredients={[{ id: 'i1', name: 'Butter' }]}
        onIngredientActivate={onActivate}
      />,
    )
    expect(screen.getByTestId('timer-chip')).toBeInTheDocument()
    const ingredientChip = screen.getByTestId('ingredient-chip')
    expect(ingredientChip).toBeInTheDocument()
    expect(ingredientChip).toHaveTextContent('Butter')
  })

  it('fires onIngredientActivate with the ingredientId when the chip is tapped', async () => {
    const user = userEvent.setup()
    const onActivate = vi.fn()
    render(
      <CookStepCard
        step={{
          id: 's2',
          position: 1,
          content: 'Butter unterrühren.',
        }}
        stepNumber={1}
        totalSteps={1}
        timerStates={DEFAULTS.timerStates}
        onTimerStateChange={DEFAULTS.onTimerStateChange}
        ingredients={[{ id: 'i1', name: 'Butter' }]}
        onIngredientActivate={onActivate}
      />,
    )
    await user.click(screen.getByTestId('ingredient-chip'))
    expect(onActivate).toHaveBeenCalledWith('i1')
  })

  it('renders only plain text when no ingredients / timers match', () => {
    render(
      <CookStepCard
        step={{
          id: 's3',
          position: 2,
          content: 'Nach Geschmack würzen.',
        }}
        stepNumber={3}
        totalSteps={3}
        timerStates={DEFAULTS.timerStates}
        onTimerStateChange={DEFAULTS.onTimerStateChange}
        ingredients={[{ id: 'i1', name: 'Butter' }]}
        onIngredientActivate={DEFAULTS.onIngredientActivate}
      />,
    )
    expect(screen.queryByTestId('ingredient-chip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('timer-chip')).not.toBeInTheDocument()
    expect(screen.getByText('Nach Geschmack würzen.')).toBeInTheDocument()
  })
})

describe('CookStepCard — timer state survives step transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Minimal harness that mimics how CookModePage will own the timer-state
   * map: a parent state-holder swaps between two steps while threading
   * the same `Map<string, TimerChipState>` through both CookStepCards.
   */
  function Harness() {
    const [stepIdx, setStepIdx] = useState(0)
    const [timerStates, setTimerStates] = useState<Map<string, TimerChipState>>(
      () => new Map(),
    )
    const steps: RecipeStepDto[] = [
      { id: 's1', position: 0, content: '10 Minuten ziehen lassen.' },
      { id: 's2', position: 1, content: 'Danach servieren.' },
    ]
    const current = steps[stepIdx]!
    function setTimerState(key: string, next: TimerChipState) {
      setTimerStates((prev) => {
        const copy = new Map(prev)
        copy.set(key, next)
        return copy
      })
    }
    return (
      <div>
        <button type="button" onClick={() => setStepIdx((i) => (i === 0 ? 1 : 0))}>
          toggle
        </button>
        <CookStepCard
          step={current}
          stepNumber={stepIdx + 1}
          totalSteps={2}
          timerStates={timerStates}
          onTimerStateChange={setTimerState}
          ingredients={[]}
          onIngredientActivate={() => {}}
        />
      </div>
    )
  }

  it('running timer survives a navigation away + back', () => {
    render(<Harness />)
    // Start the timer on step 1.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /10 Minuten/ }))
    })
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByTestId('timer-chip')).toHaveAttribute('data-status', 'running')
    expect(screen.getByRole('button', { name: /pausieren/i })).toHaveTextContent('09:57')

    // Navigate away (step 2 has no chip) then back.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /toggle/ }))
    })
    expect(screen.queryByTestId('timer-chip')).not.toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /toggle/ }))
    })

    // Back on step 1 — timer state preserved (the interval itself
    // doesn't tick while the chip is unmounted, but the lifted state
    // carries the remaining value faithfully).
    expect(screen.getByTestId('timer-chip')).toHaveAttribute('data-status', 'running')
    expect(screen.getByRole('button', { name: /pausieren/i })).toHaveTextContent('09:57')
  })
})
