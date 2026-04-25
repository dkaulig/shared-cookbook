import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Languages } from 'lucide-react'
import type {
  RecipeComponentDto,
  RecipeStepDto,
} from '@shared-cookbook/shared'
import { ConfirmDialog } from '@/features/_shared/ConfirmDialog'
import { useMediaQuery } from '@/lib/useIsMobile'
import { useMarkAsCooked, useViewLanguageRecipe } from '../hooks'
import { CookBottomBar } from './CookBottomBar'
import { CookFinishCard } from './CookFinishCard'
import { CookStepCard } from './CookStepCard'
import { CookTopBar } from './CookTopBar'
import { MiseEnPlaceList } from './MiseEnPlaceList'
import { PortionsPickerOverlay } from './PortionsPickerOverlay'
import type { TimerChipState } from './TimerChip'
import { useWakeLock } from './useWakeLock'

/**
 * COMP-2 — flattened view of a component's step plus the component
 * itself so the step pane can render "Step N of M" across the whole
 * recipe while still knowing which component the step belongs to (for
 * the optional chip above multi-component steps).
 */
interface FlatStep {
  step: RecipeStepDto
  component: RecipeComponentDto
}

/**
 * TABLET-4 — the Cook-Now stage switches to a two-pane layout on tablet
 * landscape (≥ 768 px AND landscape orientation). Left pane keeps the
 * mise-en-place list always visible, right pane holds the current
 * step — so the cook doesn't have to tab-switch mid-step to see the
 * ingredients. Portrait + mobile keep the v0.9.0 single-pane tab flow.
 *
 * Scoped to this component via `useMediaQuery` — no global CSS variable,
 * no new Tailwind variant. The query mirrors the wording the TABLET-4
 * tests assert against (`min-width: 768px` + `orientation: landscape`).
 */
const COOK_LANDSCAPE_QUERY =
  '(min-width: 768px) and (orientation: landscape)'

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

  // LANG-2-FU-1 — Cook-Now honors the active translation toggled on the
  // detail page (LANG-2 design-doc Q5-B "view-respecting"). The hook
  // reads the cached translation for the active UI lang and merges it
  // onto the recipe via `applyTranslation` so the cook never tab-
  // switches from EN-detail into DE-cook. Deep-link safe: when the user
  // lands on Cook-Now via a bookmarked URL there's no cached
  // translation → renders the original recipe verbatim, no implicit
  // LLM re-fetch.
  const detail = useViewLanguageRecipe(recipeId)
  const markCooked = useMarkAsCooked(recipeId)
  const { t } = useTranslation()

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

  // TABLET-4 — render two panes when the tablet is in landscape.
  const isLandscape = useMediaQuery(COOK_LANDSCAPE_QUERY)

  // COMP-2 — components ordered by position. Derive-once so downstream
  // memos can re-use the same reference (stable when recipe.components
  // is stable).
  const orderedComponents = useMemo<RecipeComponentDto[]>(() => {
    if (!detail.recipe) return []
    return detail.recipe.components
      .slice()
      .sort((a, b) => a.position - b.position)
  }, [detail.recipe])

  // COMP-2 — mise-en-place groups by component. Each group carries the
  // component's ingredients (already position-sorted by the server) plus
  // a display label ("Hauptgericht" fallback when a multi-component
  // recipe has a null-labelled entry). Single-default recipes collapse
  // to a single group which the list component renders without a
  // sub-header.
  const ingredientGroups = useMemo(() => {
    return orderedComponents.map((component) => ({
      component,
      label: component.label ?? 'Hauptgericht',
      ingredients: component.ingredients,
    }))
  }, [orderedComponents])

  // COMP-2 — flattened step list. Steps are sequential across all
  // components in component-order + intra-component position order,
  // carrying a back-reference to the owning component for the optional
  // "component chip" above the current step.
  const sortedSteps = useMemo<FlatStep[]>(() => {
    const out: FlatStep[] = []
    for (const component of orderedComponents) {
      const steps = component.steps
        .slice()
        .sort((a, b) => a.position - b.position)
      for (const step of steps) {
        out.push({ step, component })
      }
    }
    return out
  }, [orderedComponents])

  // COOK-2 — narrow the recipe ingredients to the `{id, name}` shape
  // CookStepCard needs, memoised on the underlying list so we don't
  // allocate a fresh array on every render (which would bust the
  // `tokens` useMemo inside CookStepCard). Server DTOs always carry an
  // id at runtime — the shared type marks it optional only because
  // create-payloads omit it, never recipe-detail reads — so we filter
  // out the impossible-in-practice no-id case instead of inventing a
  // fallback that would diverge from the mise-en-place row keys.
  const stepIngredients = useMemo<Array<{ id: string; name: string }>>(() => {
    const out: Array<{ id: string; name: string }> = []
    for (const component of orderedComponents) {
      for (const ing of component.ingredients) {
        if (ing.id) out.push({ id: ing.id, name: ing.name })
      }
    }
    return out
  }, [orderedComponents])

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

  if (detail.isError || !detail.recipe) {
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

  const recipe = detail.recipe
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
  // TABLET-4 — two-pane layout is only on step 1..N in landscape.
  // Mise-en-place (step 0) stays full-width so the user focuses on
  // prep; finish (step totalSteps+1) collapses to the celebration card.
  const onStepPane = step >= 1 && step <= totalSteps
  const showTwoPane = isLandscape && onStepPane

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

      {detail.isStaleTranslation && (
        <div
          data-testid="cook-translation-stale-hint"
          role="status"
          className="flex items-center gap-2 border-b border-[hsl(var(--primary)/0.25)] bg-[hsl(var(--primary)/0.08)] px-4 py-1.5 text-[12px] leading-snug text-[hsl(var(--muted-foreground))]"
        >
          <Languages
            className="h-[14px] w-[14px] shrink-0 text-[hsl(var(--primary))]"
            aria-hidden="true"
          />
          <span>
            {t('recipes.translation.staleHint', {
              defaultValue:
                'Das Rezept wurde geändert; die Übersetzung könnte veraltet sein.',
            })}
          </span>
        </div>
      )}

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

        {showBottomBar && (
          <div
            data-testid="cook-stage-body"
            // TABLET-4 — landscape on step 1..N splits the stage into
            // a two-column CSS grid (40% mise / 60% step). Everywhere
            // else (portrait, mobile, step 0, finish) stays a plain
            // block so the single-pane flow from v0.9.0 is byte-
            // identical.
            className={
              showTwoPane
                ? 'grid h-full grid-cols-[2fr_3fr] divide-x divide-border'
                : ''
            }
          >
            {(step === 0 || showTwoPane) && (
              <div
                data-testid="cook-pane-mise"
                className={showTwoPane ? 'h-full overflow-y-auto py-6' : ''}
              >
                <MiseEnPlaceList
                  groups={ingredientGroups}
                  defaultServings={recipe.defaultServings}
                  sessionServings={portions}
                  checked={checkedIngredientIds}
                  onToggle={toggleChecked}
                  highlightedIngredientId={highlight?.id ?? null}
                  highlightNonce={highlight?.nonce ?? 0}
                />
              </div>
            )}

            {onStepPane && sortedSteps[step - 1] && (
              <div
                data-testid="cook-pane-step"
                className={showTwoPane ? 'h-full overflow-y-auto py-6' : ''}
              >
                {/*
                  COMP-2 — when the recipe is multi-component, surface
                  the current step's owning component as a small chip
                  above the card so the cook knows which sub-recipe
                  they're on. Suppressed on single-default recipes
                  where the chip would just repeat "Hauptgericht".
                */}
                {orderedComponents.length > 1 && (
                  <div className="mx-auto mb-3 w-full max-w-2xl px-6 md:px-12">
                    <span
                      data-testid="cook-step-component-chip"
                      className="inline-flex items-center rounded-full bg-[hsl(var(--primary)/0.1)] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[hsl(var(--primary))]"
                    >
                      {sortedSteps[step - 1]!.component.label ?? 'Hauptgericht'}
                    </span>
                  </div>
                )}
                <CookStepCard
                  step={sortedSteps[step - 1]!.step}
                  stepNumber={step}
                  totalSteps={totalSteps}
                  timerStates={timerStates}
                  onTimerStateChange={handleTimerStateChange}
                  ingredients={stepIngredients}
                  onIngredientActivate={handleIngredientActivate}
                />
              </div>
            )}
          </div>
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
