import { useEffect, useMemo, useState } from 'react'
import { Images } from 'lucide-react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type {
  ApiError,
  IngredientDto,
  RecipeComponentDto,
  RecipeDetailDto,
  RecipeSnapshot,
  RecipeStepDto,
} from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/features/_shared/ConfirmDialog'
import { VersionMismatchError } from '@/features/_shared/apiError'
import { RatingWidget } from '@/features/ratings/RatingWidget'
import { useRatings } from '@/features/ratings/hooks'
import { useGroup } from '@/features/groups/hooks'
import { useAuth } from '@/features/auth/useAuth'
import { useImportCandidates } from '@/features/imports/hooks'
import {
  useDeleteRecipe,
  useMarkAsCooked,
  useRecipe,
  useRecipeOriginImport,
  useReimportRecipe,
} from './hooks'
import { ChangeCoverDialog } from './ChangeCoverDialog'
import { recipeQueryKeys } from './queryKeys'
import { RecipeDetailHeader } from './RecipeDetailHeader'
import { PortionStepperCard } from './PortionStepperCard'
import { IngredientChecklist } from './IngredientChecklist'
import { StepList } from './StepList'
import { NutritionSection } from './NutritionSection'
import { RecipeHistoryPanel } from './RecipeHistoryPanel'
import { RecipeActionBar } from './RecipeActionBar'
import { ForkRecipeDialog } from './ForkRecipeDialog'
import { useBottomZoneSlot } from '@/components/layout/bottomZone'

/**
 * DS5 recipe-detail page. Composes the hero header, portion stepper,
 * ingredient checklist, numbered steps, rating widget, history panel
 * and sticky action bar into the full page layout mirrored from
 * `docs/mockups/warme-kueche-recipe-detail.html`.
 *
 * State:
 *   - `servings` is held here so PortionStepperCard and
 *     IngredientChecklist stay in sync via props without a shared store.
 *   - `forkDialogOpen` gates the existing ForkRecipeDialog (S5).
 *   - `deleteError` surfaces any failure of the delete mutation
 *     inline above the action bar.
 *
 * Auth, RBAC, and 404/403 handling happen server-side — this page only
 * renders a friendly "nicht gefunden" message when the detail fetch
 * resolves to an error.
 */
export function RecipeDetailPage() {
  const params = useParams<{ groupId: string; recipeId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const recipeId = params.recipeId ?? ''
  const groupId = params.groupId ?? ''

  const detail = useRecipe(recipeId)
  const group = useGroup(groupId)
  const ratings = useRatings(recipeId)
  const deleteMutation = useDeleteRecipe(groupId)
  const markCooked = useMarkAsCooked(recipeId)
  const reimportMutation = useReimportRecipe(recipeId)
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const [servings, setServings] = useState<number | null>(null)
  const [forkDialogOpen, setForkDialogOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // BUG-004 — open-state for the shadcn-style confirm modal that
  // replaced the native `window.confirm('Rezept wirklich löschen?')`.
  const [deleteOpen, setDeleteOpen] = useState(false)
  // REIMPORT-1 — confirm-dialog + inline-error state for the reimport
  // flow. The flow lives on the detail page (not in a separate dialog
  // component) because it reuses the existing ConfirmDialog primitive
  // and navigates away on success — a dedicated component would just
  // be a wrapper around the state triple.
  const [reimportOpen, setReimportOpen] = useState(false)
  const [reimportError, setReimportError] = useState<string | null>(null)
  // REIMPORT-1 — success banner surfaces when the progress page
  // redirects back with `state.reimportSuccess`. Auto-hides after 4 s
  // so it doesn't linger on subsequent navigations.
  const initialReimportSuccess =
    !!(location.state as { reimportSuccess?: boolean } | null)?.reimportSuccess
  const [reimportSuccess, setReimportSuccess] = useState(initialReimportSuccess)
  useEffect(() => {
    if (!reimportSuccess) return
    const t = window.setTimeout(() => setReimportSuccess(false), 4000)
    return () => window.clearTimeout(t)
  }, [reimportSuccess])

  // COVER-0 Slice E — "Cover ändern" modal state. The modal mounts
  // lazily when the owner + origin-import + candidates gate resolves.
  // `coverGoneForSession` flips once if a mid-session 410 surfaces, so
  // the button stays hidden even if the candidates query later retries
  // and briefly returns success before the cache invalidates.
  const [changeCoverOpen, setChangeCoverOpen] = useState(false)
  const [coverGoneForSession, setCoverGoneForSession] = useState(false)
  const isOwner = !!detail.data && user?.id === detail.data.createdByUserId
  const originImportQuery = useRecipeOriginImport(recipeId, {
    enabled: isOwner && !coverGoneForSession,
  })
  const originImportId = originImportQuery.data?.importId ?? null
  // Prefetch candidates so the button only mounts when there's actually
  // something to pick. Mirrors the design doc's "hide the button if the
  // candidates endpoint 410s" rule.
  const coverCandidatesQuery = useImportCandidates(
    originImportId ?? undefined,
    { enabled: !!originImportId && !coverGoneForSession },
  )
  const canShowCoverButton =
    isOwner &&
    !coverGoneForSession &&
    !!originImportId &&
    coverCandidatesQuery.isSuccess &&
    (coverCandidatesQuery.data?.length ?? 0) >= 1

  // Hook for the history panel — needs a snapshot-shaped view of the
  // live detail. Keep the hook order stable by computing it before any
  // early returns.
  const currentSnapshot = useMemo(
    () => (detail.data ? toSnapshot(detail.data) : null),
    [detail.data],
  )

  // BUG-036 — push the contextual "In Wochenplan" + "Jetzt gekocht"
  // row into the unified Bottom-Zone slot. Previously the action bar
  // rendered inline at the end of the page with its own fixed-bottom
  // wrapper. Hook must run before the early returns below so its order
  // stays stable across re-renders.
  const recipeIdForSlot = detail.data?.id ?? ''
  useBottomZoneSlot(
    detail.data && groupId ? (
      <RecipeActionBar
        groupId={groupId}
        recipeId={recipeIdForSlot}
        onMarkCooked={() => markCooked.mutateAsync()}
        markCookedPending={markCooked.isPending}
      />
    ) : null,
    [groupId, recipeIdForSlot, markCooked.isPending],
  )

  if (!recipeId) return <Navigate to={`/groups/${groupId}`} replace />

  if (detail.isLoading) {
    return (
      <div aria-label="Rezept wird geladen">
        <Skeleton className="h-[260px] w-full" />
        <main className="mx-auto max-w-3xl px-5 py-6 md:max-w-[920px] md:px-8">
          <Skeleton className="mb-4 h-10 w-2/3" />
          <Skeleton className="mb-2 h-4 w-1/2" />
          <Skeleton className="mb-6 h-4 w-1/3" />
          <Skeleton className="mb-6 h-24 w-full" />
          <Skeleton className="mb-3 h-6 w-32" />
          <Skeleton className="mb-6 h-40 w-full" />
          <Skeleton className="mb-3 h-6 w-32" />
          <Skeleton className="mb-3 h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </main>
      </div>
    )
  }

  if (detail.isError || !detail.data || !currentSnapshot) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p
          role="alert"
          className="rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
        >
          Rezept konnte nicht geladen werden.
        </p>
        <button
          type="button"
          className="mt-4 inline-block text-sm text-[hsl(var(--primary))] underline"
          onClick={() => navigate(`/groups/${groupId}`)}
        >
          ← Zur Gruppe
        </button>
      </main>
    )
  }

  const recipe = detail.data
  const groupDefaultServings = group.data?.defaultServings ?? recipe.defaultServings
  const groupName = group.data?.name ?? 'Gruppe'
  const currentServings = servings ?? recipe.defaultServings
  const aggregate = ratings.data?.aggregate

  // COMP-2 — single-default recipes render exactly like today (no
  // component header chrome, flat ingredient + step lists). Multi-
  // component recipes get per-component <h2> sections. The "null label
  // in a multi-component recipe" case falls through to the German
  // fallback "Hauptgericht" (design-doc §Detail page).
  const orderedComponents = [...recipe.components].sort(
    (a, b) => a.position - b.position,
  )
  const isSingleDefault =
    orderedComponents.length === 1 && orderedComponents[0]?.label == null

  async function handleConfirmDelete() {
    setDeleteError(null)
    try {
      await deleteMutation.mutateAsync(recipeId)
      setDeleteOpen(false)
      navigate(`/groups/${groupId}`)
    } catch (err) {
      const apiErr = err as ApiError
      setDeleteError(apiErr.message || 'Rezept konnte nicht gelöscht werden.')
      setDeleteOpen(false)
    }
  }

  // REIMPORT-1 — edit-right gate mirrors the NutritionSection rule so
  // Members-but-not-authors stay read-only. The detail-page owns the
  // gate (not the header) because the auth context only lives here.
  const canReimport =
    !!recipe && (user?.role === 'Admin' || user?.id === recipe.createdByUserId)

  async function handleConfirmReimport() {
    if (!recipe) return
    setReimportError(null)
    try {
      const { importId } = await reimportMutation.mutateAsync(recipe.version)
      setReimportOpen(false)
      // Navigate to the shared progress page. The detail-page group id
      // is passed as router state for the page's sessionStorage memo
      // fallback (matches the standard import-url flow).
      //
      // REPLACE is load-bearing: the progress page is a transient screen
      // that itself redirects with `replace` back to this same detail URL
      // on success. If we PUSHED here instead, the history stack would
      // accumulate a duplicate detail entry (`.../recipes/:r` → progress
      // → `.../recipes/:r` again), and the browser Back button would eat
      // one visually-invisible back before landing on the group's recipe
      // list. Replacing keeps the stack clean: `/groups/:g` → detail (now
      // progress, then detail again after Done) → Back → `/groups/:g`.
      navigate(`/rezepte/import/${encodeURIComponent(importId)}`, {
        state: { groupId },
        replace: true,
      })
    } catch (err) {
      // 409 version_mismatch → invalidate the recipe query so the next
      // render picks up the server's current version + surface a user-
      // facing hint. The dialog closes so the user can re-open it after
      // the recipe refetches.
      if (err instanceof VersionMismatchError) {
        void queryClient.invalidateQueries({
          queryKey: recipeQueryKeys.detail(recipeId),
        })
        setReimportError(
          'Das Rezept wurde parallel geändert. Bitte erneut versuchen.',
        )
      } else {
        const apiErr = err as ApiError
        setReimportError(
          apiErr.message || 'Reimport konnte nicht gestartet werden.',
        )
      }
      setReimportOpen(false)
    }
  }

  return (
    <>
      <RecipeDetailHeader
        recipe={recipe}
        groupId={groupId}
        avgRating={aggregate?.avg ?? null}
        ratingCount={aggregate?.count ?? 0}
        sourceGroupName={null}
        canReimport={canReimport}
        onBack={() => navigate(`/groups/${groupId}`)}
        onFork={() => setForkDialogOpen(true)}
        onEdit={() => navigate(`/groups/${groupId}/recipes/${recipe.id}/edit`)}
        onDelete={() => setDeleteOpen(true)}
        onReimport={() => {
          setReimportError(null)
          setReimportOpen(true)
        }}
      />

      {/*
       * TABLET-3 — Recipe-Detail two-column layout at md:+.
       *
       * Mobile (< md) keeps the pre-refactor single-column flow: each
       * data-testid wrapper is a plain <div> with no grid styles, so
       * children stack in document order (ingredients → nutrition →
       * steps → rating → history).
       *
       * Tablet/desktop (md:+) switches to a CSS grid with the left
       * column pinned at `--split-left-width` (340 px, shared with the
       * TABLET-0 SplitPane primitive) and the right column taking the
       * rest (`1fr`). The left column uses `position: sticky` with
       * `top-5` so ingredients + nutrition + history stay visible while
       * the steps list scrolls in the main `<main>` scroll container
       * (AppLayout ships `<main>` as the sole scroll root per BUG-039).
       * `self-start` on the left column is required so sticky works
       * inside a grid — the default `stretch` would make the column
       * match the right column's height and sticky would have no room
       * to scroll against.
       */}
      <main className="mx-auto max-w-3xl px-5 pb-32 md:max-w-[1200px] md:px-8">
        {deleteError && (
          <p
            role="alert"
            className="mt-4 rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
          >
            {deleteError}
          </p>
        )}

        {reimportError && (
          <p
            role="alert"
            className="mt-4 rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
          >
            {reimportError}
          </p>
        )}

        {reimportSuccess && (
          <p
            role="status"
            className="mt-4 rounded-[12px] bg-[hsl(var(--primary)/0.08)] px-3 py-2 text-sm text-foreground ring-1 ring-[hsl(var(--primary)/0.25)]"
          >
            Rezept erfolgreich aktualisiert.
          </p>
        )}

        {/* COVER-0 Slice E — "Cover ändern" trigger + 410 banner. */}
        {canShowCoverButton && (
          <div className="mt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setChangeCoverOpen(true)}
            >
              <Images className="h-4 w-4" aria-hidden="true" />
              Cover ändern
            </Button>
          </div>
        )}

        {coverGoneForSession && (
          <p
            role="status"
            className="mt-4 rounded-[12px] bg-[hsl(var(--muted)/0.4)] px-3 py-2 text-sm text-muted-foreground ring-1 ring-border"
          >
            Import-Kandidaten sind nicht mehr verfügbar.
          </p>
        )}

        <div
          data-testid="recipe-detail-grid"
          className="mt-5 md:grid md:grid-cols-[var(--split-left-width)_1fr] md:gap-8"
        >
          <div
            data-testid="recipe-detail-left"
            className="md:sticky md:top-5 md:self-start"
          >
            <PortionStepperCard
              servings={currentServings}
              onServingsChange={setServings}
              groupDefaultServings={groupDefaultServings}
              groupName={groupName}
            />

            <section className="mt-7">
              <h2 className="mb-3.5 font-serif text-[24px] font-semibold tracking-[-0.005em] text-foreground">
                Zutaten{' '}
                <span className="ml-2 text-[12px] font-normal text-[hsl(var(--muted-foreground))]">
                  Abhaken was du schon hast
                </span>
              </h2>
              {isSingleDefault ? (
                <IngredientChecklist
                  ingredients={orderedComponents[0]!.ingredients}
                  defaultServings={recipe.defaultServings}
                  servings={currentServings}
                />
              ) : (
                <div className="flex flex-col gap-5">
                  {orderedComponents.map((component) => (
                    <div key={component.id ?? `pos-${component.position}`}>
                      <h3
                        data-testid="recipe-detail-component-heading"
                        className="mb-2 font-serif text-[18px] font-semibold tracking-[-0.005em] text-foreground"
                      >
                        {componentDisplayLabel(component)}
                      </h3>
                      <IngredientChecklist
                        ingredients={component.ingredients}
                        defaultServings={recipe.defaultServings}
                        servings={currentServings}
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>

            <NutritionSection
              recipeId={recipe.id}
              nutrition={recipe.nutritionEstimate}
              canEdit={
                user?.role === 'Admin' || user?.id === recipe.createdByUserId
              }
            />

            <section className="mt-7">
              <RecipeHistoryPanel recipeId={recipe.id} current={currentSnapshot} />
            </section>
          </div>

          <div
            data-testid="recipe-detail-right"
            className="mt-7 md:mt-0 md:min-w-0"
          >
            <section>
              <h2 className="mb-3.5 font-serif text-[24px] font-semibold tracking-[-0.005em] text-foreground">
                Zubereitung
              </h2>
              {isSingleDefault ? (
                <StepList steps={orderedComponents[0]!.steps} />
              ) : (
                <div className="flex flex-col gap-6">
                  {orderedComponents.map((component) => (
                    <div key={component.id ?? `pos-${component.position}`}>
                      <h3
                        data-testid="recipe-detail-component-heading"
                        className="mb-2 font-serif text-[18px] font-semibold tracking-[-0.005em] text-foreground"
                      >
                        {componentDisplayLabel(component)}
                      </h3>
                      <StepList steps={component.steps} />
                    </div>
                  ))}
                </div>
              )}
            </section>

            {recipe.sourceUrl && (
              <p className="mt-6 text-[13px]">
                <a
                  href={recipe.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[hsl(var(--primary))] underline"
                >
                  Zur Original-Quelle ↗
                </a>
              </p>
            )}

            <section className="mt-7">
              <h2 className="mb-3.5 font-serif text-[24px] font-semibold tracking-[-0.005em] text-foreground">
                Bewertungen
              </h2>
              <RatingWidget recipeId={recipe.id} />
            </section>
          </div>
        </div>
      </main>

      {/* BUG-036 — the sticky action row now lives in the Bottom-Zone
          slot (see the `useBottomZoneSlot` call above). No inline
          render here anymore. */}

      {forkDialogOpen && (
        <ForkRecipeDialog
          recipeId={recipe.id}
          sourceGroupId={recipe.groupId}
          onClose={() => setForkDialogOpen(false)}
        />
      )}

      {changeCoverOpen && originImportId && (
        <ChangeCoverDialog
          recipeId={recipe.id}
          importId={originImportId}
          onClose={() => setChangeCoverOpen(false)}
          onCandidatesExpired={() => {
            setChangeCoverOpen(false)
            setCoverGoneForSession(true)
          }}
        />
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Rezept wirklich löschen?"
        description="Diese Aktion kann nicht rückgängig gemacht werden. Das Rezept verschwindet für alle Gruppenmitglieder."
        confirmLabel="Löschen"
        onConfirm={handleConfirmDelete}
        isLoading={deleteMutation.isPending}
      />

      {/* REIMPORT-1 — confirm-before-action dialog. Description is a
          ReactNode so the "link drift" hint can sit in its own amber
          callout box below the main body copy. */}
      <ConfirmDialog
        open={reimportOpen}
        onOpenChange={setReimportOpen}
        title="Rezept neu importieren?"
        description={
          <>
            <p className="mb-3">
              Der ursprüngliche Import wird erneut ausgeführt und überschreibt
              Titel, Zutaten und Schritte mit den frischen Daten. Fotos,
              Bewertungen und &bdquo;Zuletzt gekocht&ldquo;-Historie bleiben
              erhalten. Manuelle Änderungen am Rezept gehen verloren.
            </p>
            <p className="rounded-[10px] bg-[hsl(var(--primary)/0.08)] px-3 py-2 text-[13px] leading-[1.45] text-foreground ring-1 ring-[hsl(var(--primary)/0.2)]">
              Falls der Link zwischenzeitlich geändert wurde, kann ein
              komplett anderes Rezept entstehen.
            </p>
          </>
        }
        confirmLabel="Reimport starten"
        onConfirm={handleConfirmReimport}
        isLoading={reimportMutation.isPending}
      />
    </>
  )
}

/**
 * Project a `RecipeDetailDto` onto the snapshot shape the history panel
 * + diff modal consume. Mirrors the .NET `RecipeRevisionService.RecipeSnapshot`
 * contract — keeps the comparison apples-to-apples regardless of how the
 * detail DTO evolves.
 *
 * COMP-2 — ingredients + steps flow across all components in component-
 * order, preserving their per-component `position` (so the snapshot
 * retains the original positions). The snapshot shape itself is still
 * flat on purpose: the revision diff doesn't surface components today,
 * and re-introducing them here would widen the server contract.
 */
function toSnapshot(recipe: RecipeDetailDto): RecipeSnapshot {
  const orderedComponents = [...recipe.components].sort(
    (a, b) => a.position - b.position,
  )
  const ingredients = orderedComponents.flatMap(
    (c): IngredientDto[] => c.ingredients,
  )
  const steps = orderedComponents.flatMap(
    (c): RecipeStepDto[] => c.steps,
  )
  return {
    title: recipe.title,
    description: recipe.description ?? null,
    defaultServings: recipe.defaultServings,
    prepTimeMinutes: recipe.prepTimeMinutes ?? null,
    difficulty: recipe.difficulty as 1 | 2 | 3,
    sourceUrl: recipe.sourceUrl ?? null,
    ingredients: ingredients.map((i) => ({
      position: i.position,
      quantity: i.quantity ?? null,
      unit: i.unit,
      name: i.name,
      note: i.note ?? null,
      scalable: i.scalable,
    })),
    steps: steps.map((s) => ({ position: s.position, content: s.content })),
    tagIds: recipe.tags
      .map((t) => t.id)
      .slice()
      .sort(),
  }
}

/**
 * COMP-2 — resolves the label copy for a component in multi-component
 * render. Non-null labels render verbatim; null labels inside a multi-
 * component recipe fall back to the German "Hauptgericht" placeholder.
 * Single-default recipes never reach this helper (the detail page
 * suppresses component chrome entirely in that case).
 */
function componentDisplayLabel(component: RecipeComponentDto): string {
  return component.label ?? 'Hauptgericht'
}
