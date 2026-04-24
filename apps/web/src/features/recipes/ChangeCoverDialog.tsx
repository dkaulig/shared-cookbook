import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ApiError } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { useImportCandidates } from '@/features/imports/hooks'
import { useSwapRecipeCover } from './hooks'
import {
  ImportCandidatesGrid,
  type ImportCandidateTile,
} from './ImportCandidatesGrid'

/**
 * COVER-0 Slice E — "Cover ändern" modal on the recipe detail page.
 *
 * Renders the unpromoted candidates of the recipe's origin-import as a
 * picker grid. The grid component already understands selection + cover
 * as separate concerns (designed for the multi-cover RecipeFormPage
 * flow), but on the detail page the semantics collapse to single-select:
 * the user picks one new cover. We reuse the grid by seeding the first
 * candidate as cover, keeping `selectedIds = [coverStagedPhotoId]` at
 * all times, and mapping both onSelectionChange / onCoverChange back to
 * the same "cover changed" action.
 *
 * Commit semantics: explicit "Speichern" (not auto-commit-on-tap) so a
 * stray tap on the recipe detail page never silently swaps the cover.
 * Cancel button + overlay-click both dismiss without saving.
 *
 * Error surface:
 *   - 410 from the swap → parent handles (close + banner + hide button
 *     for the session). We propagate via `onCandidatesExpired`.
 *   - 403 / 400 → inline German error in the modal body; modal stays
 *     open so the user can pick another candidate.
 */
export interface ChangeCoverDialogProps {
  recipeId: string
  importId: string
  onClose: () => void
  /**
   * Fired when the swap fails with `candidates_expired` / HTTP 410.
   * Parent should close the modal, show the session-wide banner, and
   * suppress the "Cover ändern" button for the rest of the session.
   */
  onCandidatesExpired: () => void
}

export function ChangeCoverDialog({
  recipeId,
  importId,
  onClose,
  onCandidatesExpired,
}: ChangeCoverDialogProps) {
  const { t } = useTranslation()
  const candidatesQuery = useImportCandidates(importId)
  const swap = useSwapRecipeCover(recipeId, importId)

  const candidates: ImportCandidateTile[] = (candidatesQuery.data ?? []).map(
    (c) => ({ stagedPhotoId: c.stagedPhotoId, signedUrl: c.signedUrl }),
  )

  // Seed with the first candidate as the initial cover choice so the
  // user sees a highlighted starting point. The first candidate is the
  // extract job's default cover (candidateOrder=0) — picking a different
  // one is the whole point of this modal, so pre-selecting the default
  // makes the "change" action an explicit single tap rather than "first
  // pick any, then tap star".
  const [coverStagedPhotoId, setCoverStagedPhotoId] = useState<string | null>(
    () => candidates[0]?.stagedPhotoId ?? null,
  )
  const [error, setError] = useState<string | null>(null)

  // Grid contract: cover must be ∈ selectedIds. Collapse both handlers
  // to "treat this tile as the new cover" so single-select semantics
  // fall out of the same primitive that backs the multi-select picker
  // on RecipeFormPage. Defence-in-depth: reject ids that aren't in the
  // candidate list so a DOM-level tamper can't send a stray id to the
  // server (server revalidates ownership + linkage anyway).
  function handlePick(stagedPhotoId: string) {
    if (!candidates.some((c) => c.stagedPhotoId === stagedPhotoId)) return
    setCoverStagedPhotoId(stagedPhotoId)
    setError(null)
  }

  async function handleSave() {
    if (!coverStagedPhotoId) return
    setError(null)
    try {
      await swap.mutateAsync(coverStagedPhotoId)
      onClose()
    } catch (err) {
      const apiErr = err as ApiError
      if (apiErr.code === 'candidates_expired') {
        onCandidatesExpired()
        return
      }
      setError(
        apiErr.message ||
          t('recipes.coverDialog.errorFailed', {
            defaultValue: 'Cover konnte nicht geändert werden.',
          }),
      )
    }
  }

  const selectedIds = coverStagedPhotoId ? [coverStagedPhotoId] : []

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="change-cover-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="change-cover-dialog-title"
          className="mb-1 font-serif text-xl font-semibold"
        >
          {t('recipes.coverDialog.title', { defaultValue: 'Cover ändern' })}
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {t('recipes.coverDialog.description', {
            defaultValue:
              'Wähle ein Bild aus den Import-Kandidaten. Das aktuelle Cover bleibt als zusätzliches Foto erhalten.',
          })}
        </p>

        {candidatesQuery.isLoading && (
          <p className="text-sm text-muted-foreground">
            {t('recipes.coverDialog.loading', {
              defaultValue: 'Kandidaten werden geladen …',
            })}
          </p>
        )}

        {candidates.length > 0 && (
          <ImportCandidatesGrid
            candidates={candidates}
            selectedIds={selectedIds}
            coverStagedPhotoId={coverStagedPhotoId}
            onSelectionChange={(next) => {
              const last = next[next.length - 1]
              if (last) handlePick(last)
            }}
            onCoverChange={handlePick}
          />
        )}

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-md bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
          >
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={swap.isPending}
          >
            {t('common.cancel', { defaultValue: 'Abbrechen' })}
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={!coverStagedPhotoId || swap.isPending}
          >
            {swap.isPending
              ? t('recipes.coverDialog.saving', { defaultValue: 'Speichere …' })
              : t('recipes.coverDialog.submitCta', {
                  defaultValue: 'Speichern',
                })}
          </Button>
        </div>
      </div>
    </div>
  )
}
