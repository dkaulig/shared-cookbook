import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * COVER-0 — one candidate tile's inputs. Mirrors the subset of
 * {@link import('@familien-kochbuch/shared').ImportCandidate} the grid
 * actually needs (the parent owns the ordering / re-sign logic so the
 * grid stays pure).
 */
export interface ImportCandidateTile {
  stagedPhotoId: string
  signedUrl: string
  contentType?: string
}

/**
 * COVER-0 — shared picker grid. Renders up to 6 candidate thumbnails
 * (the extractor caps at 6 upstream); fewer tiles are rendered when
 * fewer candidates are supplied, never placeholder slots.
 *
 * Layout:
 *   - `xs` (default / phones): 2-column grid so an iPhone 17 Pro Max
 *     shows 2 tiles per row without horizontal scroll even with the
 *     surrounding form card's padding.
 *   - `sm:` and up: 3-column grid (the design's 3×2 shape).
 *
 * State lives in the parent — this component is a pure "dumb"
 * renderer. `selectedIds` + `coverStagedPhotoId` come in as props;
 * taps fire `onSelectionChange` / `onCoverChange` with the full
 * next-state so the parent keeps the invariant "cover is a member
 * of selectedIds" in one place.
 *
 * Cover protection: tapping the current cover tile's body is a no-op
 * — cover cannot be deselected from the grid, you change it with a
 * star-tap on another tile (which auto-selects that tile if it
 * wasn't in the selection yet).
 */
export interface ImportCandidatesGridProps {
  /** Up to 6, already ordered. Index 0 is the default cover. */
  candidates: ImportCandidateTile[]
  /** Current selection; must be a subset of `candidates`. */
  selectedIds: string[]
  /** Which tile carries the cover star; must be in `selectedIds`. */
  coverStagedPhotoId: string | null
  onSelectionChange: (nextSelectedIds: string[]) => void
  onCoverChange: (stagedPhotoId: string) => void
}

export function ImportCandidatesGrid({
  candidates,
  selectedIds,
  coverStagedPhotoId,
  onSelectionChange,
  onCoverChange,
}: ImportCandidatesGridProps) {
  function handleTileClick(stagedPhotoId: string): void {
    // Cover protection — the cover tile is locked-selected, ignore taps
    // on its body. Changing cover is a star-tap (see below).
    if (stagedPhotoId === coverStagedPhotoId) return
    const isSelected = selectedIds.includes(stagedPhotoId)
    if (isSelected) {
      onSelectionChange(selectedIds.filter((id) => id !== stagedPhotoId))
    } else {
      onSelectionChange([...selectedIds, stagedPhotoId])
    }
  }

  function handleStarClick(stagedPhotoId: string): void {
    // Star-tap on the current cover is a redundant op — skip so the
    // parent doesn't see a no-op state-change.
    if (stagedPhotoId === coverStagedPhotoId) return
    // Auto-select the tile if it isn't in the selection yet so the
    // "cover ∈ selectedIds" invariant holds after this single event.
    if (!selectedIds.includes(stagedPhotoId)) {
      onSelectionChange([...selectedIds, stagedPhotoId])
    }
    onCoverChange(stagedPhotoId)
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {candidates.map((candidate) => {
        const isSelected = selectedIds.includes(candidate.stagedPhotoId)
        const isCover = candidate.stagedPhotoId === coverStagedPhotoId
        return (
          <div
            key={candidate.stagedPhotoId}
            className="relative aspect-square"
          >
            {/* Tile body — selection toggle. Rendered as a button for
                keyboard accessibility; the <img> inside is purely
                decorative (it's the tile's own label via aria-label). */}
            <button
              type="button"
              onClick={() => handleTileClick(candidate.stagedPhotoId)}
              aria-label={isSelected ? 'Abwählen' : 'Auswählen'}
              aria-pressed={isSelected}
              className={cn(
                'block h-full w-full overflow-hidden rounded-lg ring-2 transition',
                // Ring color: blue when selected, transparent otherwise.
                isSelected
                  ? 'ring-[hsl(var(--primary))]'
                  : 'ring-transparent hover:ring-[hsl(var(--muted-foreground)/0.3)]',
              )}
            >
              <img
                src={candidate.signedUrl}
                alt="Import-Vorschau"
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </button>
            {/* Star overlay. Sits in the top-right; stays above the
                tile's own click surface so the star click doesn't
                bubble to the selection toggle. */}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                handleStarClick(candidate.stagedPhotoId)
              }}
              aria-label={isCover ? 'Cover-Bild' : 'Zum Cover machen'}
              aria-pressed={isCover}
              className={cn(
                'absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full shadow-sm transition',
                isCover
                  ? 'bg-[hsl(var(--primary))] text-white'
                  : 'bg-white/90 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))]',
              )}
            >
              <Star
                className="h-4 w-4"
                aria-hidden="true"
                fill={isCover ? 'currentColor' : 'none'}
              />
            </button>
          </div>
        )
      })}
    </div>
  )
}
