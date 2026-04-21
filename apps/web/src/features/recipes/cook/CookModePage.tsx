import { useCallback, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { ConfirmDialog } from '@/features/_shared/ConfirmDialog'
import { useMarkAsCooked, useRecipe } from '../hooks'
import { CookBottomBar } from './CookBottomBar'
import { CookFinishCard } from './CookFinishCard'
import { CookStepCard } from './CookStepCard'
import { CookTopBar } from './CookTopBar'
import { MiseEnPlaceList } from './MiseEnPlaceList'
import { PortionsPickerOverlay } from './PortionsPickerOverlay'
import type { TimerChipState } from './TimerChip'
import { useWakeLock } from './useWakeLock'

/**
 * COOK-0 — "Jetzt kochen" Modus.
 *
 * Immersive step-by-step cooking flow mounted OUTSIDE of `<AppLayout />`
 * so the shared TopNav + BottomNav don't render here. Owns its own
 * fullscreen `fixed inset-0 flex flex-col overflow-hidden` scaffold so
 * the page behaves like an app-on-top-of-an-app (the user gets an
 * exit button in the top bar rather than the regular nav).
 *
 * Session-state (not persisted):
 *   - `sessionPortions` — number of portions the user confirmed in the
 *     PortionsPickerOverlay. Defaults to `recipe.defaultServings`. All
 *     ingredient-scaling on MiseEnPlaceList + any future per-step
 *     quantity chips (COOK-2) branch off this value.
 *   - `step` — flow position. Semantics:
 *        -1 → PortionsPickerOverlay (initial)
 *         0 → MiseEnPlaceList
 *     1..N → CookStepCard per recipe step
 *       N+1 → CookFinishCard
 *   - `checkedIngredientIds` — Set of row-keys abgehakt auf der
 *     Mise-en-Place-Liste. Überlebt Step-Navigation und Portions-Picker-
 *     Reopen, wird nur beim Verlassen des Kochmodus verworfen.
 *
 * Scope guards: no wake-lock (COOK-1), no timer chips (COOK-1), no
 * ingredient-highlight chips in step text (COOK-2). These land in later
 * slices. Reuses `scaleIngredients()` via `MiseEnPlaceList` so the
 * quantity math + unit formatting stay identical to the detail page.
 */
export function CookModePage() {
  const params = useParams<{ groupId: string; recipeId: string }>()
  const navigate = useNavigate()
  const groupId = params.groupId ?? ''
  const recipeId = params.recipeId ?? ''

  const detail = useRecipe(recipeId)
  const markCooked = useMarkAsCooked(recipeId)

  const [sessionPortions, setSessionPortions] = useState<number | null>(null)
  const [step, setStep] = useState<number>(-1)
  const [checkedIngredientIds, setCheckedIngredientIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [exitDialogOpen, setExitDialogOpen] = useState(false)
  // COOK-1 — lifted timer-state map. Keyed by `${step.id}:${matchStart}`
  // so a timer's running / paused / done status survives step-navigation.
  const [timerStates, setTimerStates] = useState<Map<string, TimerChipState>>(
    () => new Map(),
  )

  // COOK-1 — keep the screen on while the user is actually cooking.
  // Active once the portions picker has been confirmed (step moves to 0
  // or higher). We don't acquire on the picker itself — reading "how
  // many portions?" is a fast interaction, no need for a lock there.
  const wakeLock = useWakeLock(step > -1)

  const sortedSteps = useMemo(() => {
    if (!detail.data) return []
    return detail.data.steps.slice().sort((a, b) => a.position - b.position)
  }, [detail.data])

  const handleTimerStateChange = useCallback(
    (key: string, next: TimerChipState) => {
      setTimerStates((prev) => {
        const copy = new Map(prev)
        copy.set(key, next)
        return copy
      })
    },
    [],
  )

  if (!recipeId) return <Navigate to={`/groups/${groupId}`} replace />

  if (detail.isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed inset-0 flex items-center justify-center bg-background text-sm text-[hsl(var(--muted-foreground))]"
      >
        Rezept wird geladen …
      </div>
    )
  }

  if (detail.isError || !detail.data) {
    return (
      <main className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <p
          role="alert"
          className="max-w-md rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
        >
          Rezept konnte nicht geladen werden.
        </p>
        <button
          type="button"
          className="text-sm text-[hsl(var(--primary))] underline"
          onClick={() => navigate(`/groups/${groupId}/recipes/${recipeId}`)}
        >
          ← Zurück zum Rezept
        </button>
      </main>
    )
  }

  const recipe = detail.data
  const totalSteps = sortedSteps.length
  const portions = sessionPortions ?? recipe.defaultServings

  function leaveCookMode() {
    navigate(`/groups/${groupId}/recipes/${recipeId}`)
  }

  function requestExit() {
    setExitDialogOpen(true)
  }

  function handleConfirmExit() {
    setExitDialogOpen(false)
    leaveCookMode()
  }

  function toggleChecked(key: string) {
    setCheckedIngredientIds((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function handlePortionsConfirm() {
    if (sessionPortions == null) {
      setSessionPortions(recipe.defaultServings)
    }
    setStep(0)
  }

  function handleBack() {
    if (step <= 0) return
    setStep((s) => s - 1)
  }

  function handleNext() {
    // Mise → first step; step n → step n+1 or finish.
    if (step >= 0 && step <= totalSteps) {
      setStep((s) => s + 1)
    }
  }

  function handleMarkedCooked() {
    leaveCookMode()
  }

  const stepLabel = computeStepLabel(step, totalSteps)
  const showBottomBar = step >= 0 && step <= totalSteps

  return (
    <div
      data-testid="cook-mode-page"
      className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground"
    >
      <CookTopBar
        onClose={requestExit}
        stepLabel={stepLabel}
        portions={portions}
        onPortionsClick={() => setStep(-1)}
      />

      <main
        data-testid="cook-stage"
        className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain"
      >
        {step === -1 && (
          <PortionsPickerOverlay
            value={portions}
            onChange={setSessionPortions}
            onConfirm={handlePortionsConfirm}
            onCancel={requestExit}
            recipeDefaultServings={recipe.defaultServings}
          />
        )}

        {step === 0 && (
          <MiseEnPlaceList
            ingredients={recipe.ingredients}
            defaultServings={recipe.defaultServings}
            sessionServings={portions}
            checked={checkedIngredientIds}
            onToggle={toggleChecked}
          />
        )}

        {step >= 1 && step <= totalSteps && sortedSteps[step - 1] && (
          <CookStepCard
            step={sortedSteps[step - 1]!}
            stepNumber={step}
            totalSteps={totalSteps}
            timerStates={timerStates}
            onTimerStateChange={handleTimerStateChange}
          />
        )}

        {step === totalSteps + 1 && (
          <CookFinishCard
            onMarkCooked={() => markCooked.mutateAsync()}
            markCookedPending={markCooked.isPending}
            onClose={leaveCookMode}
            onMarkedCooked={handleMarkedCooked}
          />
        )}
      </main>

      {showBottomBar && (
        <CookBottomBar
          backDisabled={step === 0}
          nextLabel={step === totalSteps ? 'Fertig' : 'Weiter'}
          nextIsFinish={step === totalSteps}
          onBack={handleBack}
          onNext={handleNext}
        />
      )}

      {wakeLock.granted && (
        <div
          aria-live="polite"
          className="sr-only"
          data-testid="cook-wake-lock-status"
        >
          Bildschirm bleibt an
        </div>
      )}

      <ConfirmDialog
        open={exitDialogOpen}
        onOpenChange={setExitDialogOpen}
        title="Kochmodus wirklich beenden?"
        description="Fortschritt geht verloren."
        confirmLabel="Beenden"
        onConfirm={handleConfirmExit}
      />
    </div>
  )
}

/**
 * Maps the internal `step` counter onto the user-facing label shown in
 * the top bar. Kept as a plain function so the mapping stays testable
 * + trivially greppable when COOK-1/COOK-2 add new states.
 */
function computeStepLabel(step: number, totalSteps: number): string | null {
  if (step === -1) return 'Portionen wählen'
  if (step === 0) return 'Mise en Place'
  if (step >= 1 && step <= totalSteps) return `Schritt ${step}/${totalSteps}`
  if (step === totalSteps + 1) return null
  return null
}
