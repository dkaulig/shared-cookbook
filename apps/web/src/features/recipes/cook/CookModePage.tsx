import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
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
  // Route `/groups/:groupId/recipes/:recipeId/cook` guarantees both
  // params are present — React Router wouldn't match otherwise, so we
  // assert rather than guard + fall through a `?? ''` placeholder that
  // would poison the downstream queries if it ever fired.
  const { groupId, recipeId } = useParams() as {
    groupId: string
    recipeId: string
  }
  const navigate = useNavigate()

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
  // COOK-2 — ingredient-highlight trigger. When the user taps an
  // ingredient chip inside a step we navigate back to mise-en-place
  // (step 0) and MiseEnPlaceList flashes the matching row for 1.5 s.
  // The `nonce` lets a repeat-tap on the SAME ingredient re-trigger the
  // flash — MiseEnPlaceList's effect depends on it so identical-id
  // updates still restart its fade-out timer.
  const [highlight, setHighlight] = useState<
    { id: string; nonce: number } | null
  >(null)

  // COOK-1 — keep the screen on while the user is actually cooking.
  // Active once the portions picker has been confirmed (step moves to 0
  // or higher). We don't acquire on the picker itself — reading "how
  // many portions?" is a fast interaction, no need for a lock there.
  const wakeLock = useWakeLock(step > -1)

  const sortedSteps = useMemo(() => {
    if (!detail.data) return []
    return detail.data.steps.slice().sort((a, b) => a.position - b.position)
  }, [detail.data])

  // COOK-2 — narrow the recipe ingredients to the `{id, name}` shape
  // CookStepCard needs, memoised on the underlying list so we don't
  // allocate a fresh array on every render (which would bust the
  // `tokens` useMemo inside CookStepCard). Server DTOs always carry an
  // id at runtime — the shared type marks it optional only because
  // create-payloads omit it, never recipe-detail reads — so we filter
  // out the impossible-in-practice no-id case instead of inventing a
  // fallback that would diverge from the mise-en-place row keys.
  const stepIngredients = useMemo<Array<{ id: string; name: string }>>(() => {
    if (!detail.data) return []
    const out: Array<{ id: string; name: string }> = []
    for (const ing of detail.data.ingredients) {
      if (ing.id) out.push({ id: ing.id, name: ing.name })
    }
    return out
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

  // COOK-2 — Option A: ingredient tap navigates back to mise-en-place
  // with the highlight primed. MiseEnPlaceList owns the 1.5 s fade-out
  // locally; we just bump the nonce so repeat-taps re-trigger the flash.
  const handleIngredientActivate = useCallback((ingredientId: string) => {
    setHighlight((prev) => ({
      id: ingredientId,
      nonce: (prev?.nonce ?? 0) + 1,
    }))
    setStep(0)
  }, [])

  // COOK-REV follow-up — keyboard nav per UX-invariants in the plan:
  // ArrowRight / Space advance, ArrowLeft goes back. Active only when
  // the bottom bar would be shown (step in [0, totalSteps]) and no
  // form input is focused (so typing in a text field never
  // pages the cook flow). The exit-confirm dialog owns ESC on its own;
  // we suppress all other keys while it's open to avoid surprise nav
  // behind the dialog.
  //
  // Swipe-gesture support is a future follow-up (see plan UX-invariants
  // — mentioned together with keyboard but gesture detection is a
  // bigger surface than what this fix lands).
  const totalStepsForKeyboard = sortedSteps.length
  useEffect(() => {
    if (step < 0) return
    if (exitDialogOpen) return

    function isFormInputFocused(): boolean {
      const el = document.activeElement as HTMLElement | null
      if (!el) return false
      if (el.isContentEditable) return true
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isFormInputFocused()) return

      if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'Spacebar') {
        // Next — only while the bottom-bar's next action would be active.
        if (step < 0 || step > totalStepsForKeyboard) return
        event.preventDefault()
        setStep((s) => s + 1)
        return
      }

      if (event.key === 'ArrowLeft') {
        // Back mirrors CookBottomBar's back-disabled rule: step <= 0.
        if (step <= 0) return
        event.preventDefault()
        setStep((s) => s - 1)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [step, exitDialogOpen, totalStepsForKeyboard])

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
    // Mise → first step; step n → step n+1 or finish. The bottom bar
    // that calls this is only rendered when `step` is in `[0, totalSteps]`,
    // so no bounds-check is needed here.
    setStep((s) => s + 1)
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
            highlightedIngredientId={highlight?.id ?? null}
            highlightNonce={highlight?.nonce ?? 0}
          />
        )}

        {step >= 1 && step <= totalSteps && sortedSteps[step - 1] && (
          <CookStepCard
            step={sortedSteps[step - 1]!}
            stepNumber={step}
            totalSteps={totalSteps}
            timerStates={timerStates}
            onTimerStateChange={handleTimerStateChange}
            ingredients={stepIngredients}
            onIngredientActivate={handleIngredientActivate}
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

/** Maps the internal `step` counter onto the top-bar label. */
function computeStepLabel(step: number, totalSteps: number): string | null {
  if (step === -1) return 'Portionen wählen'
  if (step === 0) return 'Mise en Place'
  if (step >= 1 && step <= totalSteps) return `Schritt ${step}/${totalSteps}`
  return null
}
