import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiError, RecipeDetailDto, RecipeSnapshot } from '@familien-kochbuch/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/features/_shared/ConfirmDialog'
import { VersionMismatchError } from '@/features/_shared/apiError'
import { RatingWidget } from '@/features/ratings/RatingWidget'
import { useRatings } from '@/features/ratings/hooks'
import { useGroup } from '@/features/groups/hooks'
import { useAuth } from '@/features/auth/useAuth'
import {
  useDeleteRecipe,
  useMarkAsCooked,
  useRecipe,
  useReimportRecipe,
} from './hooks'
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
  const reimportMutation = useReimportRecipe(recipeId, groupId)
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
      navigate(`/rezepte/import/${encodeURIComponent(importId)}`, {
        state: { groupId },
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

      <main className="mx-auto max-w-3xl px-5 pb-32 md:max-w-[920px] md:px-8">
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

        <PortionStepperCard
          className="mt-5"
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
          <IngredientChecklist
            ingredients={recipe.ingredients}
            defaultServings={recipe.defaultServings}
            servings={currentServings}
          />
        </section>

        <NutritionSection
          recipeId={recipe.id}
          nutrition={recipe.nutritionEstimate}
          canEdit={
            user?.role === 'Admin' || user?.id === recipe.createdByUserId
          }
        />

        <section className="mt-7">
          <h2 className="mb-3.5 font-serif text-[24px] font-semibold tracking-[-0.005em] text-foreground">
            Zubereitung
          </h2>
          <StepList steps={recipe.steps} />
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

        <section className="mt-7">
          <RecipeHistoryPanel recipeId={recipe.id} current={currentSnapshot} />
        </section>
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
 */
function toSnapshot(recipe: RecipeDetailDto): RecipeSnapshot {
  return {
    title: recipe.title,
    description: recipe.description ?? null,
    defaultServings: recipe.defaultServings,
    prepTimeMinutes: recipe.prepTimeMinutes ?? null,
    difficulty: recipe.difficulty as 1 | 2 | 3,
    sourceUrl: recipe.sourceUrl ?? null,
    ingredients: recipe.ingredients
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((i) => ({
        position: i.position,
        quantity: i.quantity ?? null,
        unit: i.unit,
        name: i.name,
        note: i.note ?? null,
        scalable: i.scalable,
      })),
    steps: recipe.steps
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ position: s.position, content: s.content })),
    tagIds: recipe.tags
      .map((t) => t.id)
      .slice()
      .sort(),
  }
}
