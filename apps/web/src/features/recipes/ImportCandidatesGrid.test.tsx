import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ImportCandidatesGrid,
  type ImportCandidateTile,
} from './ImportCandidatesGrid'

/**
 * COVER-0 — tests for the reusable candidate grid. The component is
 * called from both `RecipeFormPage` (prefilled picker at save time)
 * and — via a prop-level reuse — Slice E's "Cover ändern" modal on
 * the recipe detail page. Keeping these tests focused on the
 * component's public contract (props in → DOM + callbacks out) so
 * both callers share the same guarantees.
 */

function makeCandidates(n: number): ImportCandidateTile[] {
  return Array.from({ length: n }, (_, i) => ({
    stagedPhotoId: `sp-${i}`,
    signedUrl: `https://cdn.example/thumb-${i}.jpg`,
  }))
}

describe('ImportCandidatesGrid', () => {
  it('renders one tile per candidate (no placeholders for missing slots)', () => {
    const candidates = makeCandidates(4)
    render(
      <ImportCandidatesGrid
        candidates={candidates}
        selectedIds={['sp-0']}
        coverStagedPhotoId="sp-0"
        onSelectionChange={() => {}}
        onCoverChange={() => {}}
      />,
    )
    // The tile-button carries the German aria-label so we can count
    // them deterministically. Four tiles → four buttons.
    expect(screen.getAllByRole('button', { name: /Auswählen|Abwählen/ })).toHaveLength(4)
  })

  it('renders all 6 tiles when the full candidate set is present', () => {
    const candidates = makeCandidates(6)
    render(
      <ImportCandidatesGrid
        candidates={candidates}
        selectedIds={['sp-0']}
        coverStagedPhotoId="sp-0"
        onSelectionChange={() => {}}
        onCoverChange={() => {}}
      />,
    )
    expect(screen.getAllByRole('button', { name: /Auswählen|Abwählen/ })).toHaveLength(6)
  })

  it('renders the signed URL as an <img src>', () => {
    const candidates = makeCandidates(2)
    render(
      <ImportCandidatesGrid
        candidates={candidates}
        selectedIds={['sp-0']}
        coverStagedPhotoId="sp-0"
        onSelectionChange={() => {}}
        onCoverChange={() => {}}
      />,
    )
    const imgs = screen.getAllByRole('img')
    expect(imgs).toHaveLength(2)
    expect(imgs[0]).toHaveAttribute('src', 'https://cdn.example/thumb-0.jpg')
    expect(imgs[1]).toHaveAttribute('src', 'https://cdn.example/thumb-1.jpg')
  })

  it('tapping an unselected tile adds it to the selection', async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    const candidates = makeCandidates(3)
    render(
      <ImportCandidatesGrid
        candidates={candidates}
        selectedIds={['sp-0']}
        coverStagedPhotoId="sp-0"
        onSelectionChange={onSelectionChange}
        onCoverChange={() => {}}
      />,
    )
    // Tile 1 is unselected → clicking adds it.
    const tiles = screen.getAllByRole('button', { name: /Auswählen|Abwählen/ })
    await user.click(tiles[1])
    expect(onSelectionChange).toHaveBeenCalledWith(['sp-0', 'sp-1'])
  })

  it('tapping a selected non-cover tile removes it from the selection', async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    const candidates = makeCandidates(3)
    render(
      <ImportCandidatesGrid
        candidates={candidates}
        selectedIds={['sp-0', 'sp-1']}
        coverStagedPhotoId="sp-0"
        onSelectionChange={onSelectionChange}
        onCoverChange={() => {}}
      />,
    )
    // Tile 1 is selected + non-cover → clicking deselects.
    const tiles = screen.getAllByRole('button', { name: /Auswählen|Abwählen/ })
    await user.click(tiles[1])
    expect(onSelectionChange).toHaveBeenCalledWith(['sp-0'])
  })

  it('tapping the cover tile body is a no-op (cannot deselect the cover)', async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    const candidates = makeCandidates(3)
    render(
      <ImportCandidatesGrid
        candidates={candidates}
        selectedIds={['sp-0']}
        coverStagedPhotoId="sp-0"
        onSelectionChange={onSelectionChange}
        onCoverChange={() => {}}
      />,
    )
    const tiles = screen.getAllByRole('button', { name: /Auswählen|Abwählen/ })
    await user.click(tiles[0])
    // Cover protection: the selection callback must not fire when the
    // user taps the current cover tile's body. Changing cover is a
    // star-tap (see separate test).
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('star-tapping another tile fires onCoverChange and auto-selects it if unselected', async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    const onCoverChange = vi.fn()
    const candidates = makeCandidates(3)
    render(
      <ImportCandidatesGrid
        candidates={candidates}
        selectedIds={['sp-0']}
        coverStagedPhotoId="sp-0"
        onSelectionChange={onSelectionChange}
        onCoverChange={onCoverChange}
      />,
    )
    // Non-cover tiles carry the "Zum Cover machen" label; with sp-0 as
    // cover, tiles 1 & 2 surface two such buttons. Click the last one
    // (sp-2) which is both unselected and non-cover.
    const promoteButtons = screen.getAllByRole('button', {
      name: /Zum Cover machen/,
    })
    expect(promoteButtons).toHaveLength(2)
    await user.click(promoteButtons[1])
    expect(onCoverChange).toHaveBeenCalledWith('sp-2')
    expect(onSelectionChange).toHaveBeenCalledWith(['sp-0', 'sp-2'])
  })

  it('star-tapping an already-selected tile only fires onCoverChange (no duplicate selection)', async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    const onCoverChange = vi.fn()
    const candidates = makeCandidates(3)
    render(
      <ImportCandidatesGrid
        candidates={candidates}
        selectedIds={['sp-0', 'sp-1']}
        coverStagedPhotoId="sp-0"
        onSelectionChange={onSelectionChange}
        onCoverChange={onCoverChange}
      />,
    )
    // Tile sp-1 is selected but not cover — its star is the first of
    // the two "Zum Cover machen" buttons (sp-0 is the current cover,
    // labelled "Cover-Bild").
    const promoteButtons = screen.getAllByRole('button', {
      name: /Zum Cover machen/,
    })
    await user.click(promoteButtons[0])
    expect(onCoverChange).toHaveBeenCalledWith('sp-1')
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('star-tapping the current cover tile is a no-op', async () => {
    const user = userEvent.setup()
    const onCoverChange = vi.fn()
    const candidates = makeCandidates(2)
    render(
      <ImportCandidatesGrid
        candidates={candidates}
        selectedIds={['sp-0']}
        coverStagedPhotoId="sp-0"
        onSelectionChange={() => {}}
        onCoverChange={onCoverChange}
      />,
    )
    const stars = screen.getAllByRole('button', { name: /Zum Cover machen|Cover-Bild/ })
    await user.click(stars[0])
    // Already the cover — re-starring it would be a no-op on the
    // parent's state. Don't emit redundant events.
    expect(onCoverChange).not.toHaveBeenCalled()
  })
})
