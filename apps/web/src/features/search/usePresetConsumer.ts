import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { TagDto } from '@familien-kochbuch/shared'
import { readFiltersFromSearchParams, writeFiltersToSearchParams } from './urlState'
import { applyFilterPreset, isFilterPreset } from './presets'

/**
 * Consumes a `?preset=<name>` URL param once, applies the matching
 * filter(s) via `applyFilterPreset`, then clears the preset param so
 * refresh/back doesn't re-fire.
 *
 * Mounted at the `GroupDetailPage` level rather than inside
 * `<RecipeFilterPanel />` so the consumer runs even when the panel is
 * still collapsed (i.e. the user arrives via the Home quick-filter
 * chip without toggling the panel open).
 *
 * Reports via `onRandomRequest` when the preset is `random`, so the
 * page can kick off the random-pick navigation flow. Returns nothing.
 */
export function usePresetConsumer(options: {
  tags: TagDto[] | undefined
  tagsReady: boolean
  onRandomRequest: () => void
}) {
  const [params, setParams] = useSearchParams()
  const presetParam = params.get('preset')

  useEffect(() => {
    if (!presetParam || !isFilterPreset(presetParam)) return
    if (!options.tagsReady) return

    if (presetParam === 'random') {
      // Strip the preset param before firing the random side-effect so
      // the back button doesn't re-trigger the pick.
      const next = readFiltersFromSearchParams(params)
      setParams(writeFiltersToSearchParams(next), { replace: true })
      options.onRandomRequest()
      return
    }

    const tagPool = options.tags ?? []
    const current = readFiltersFromSearchParams(params)
    const merged = applyFilterPreset(current, presetParam, tagPool)
    setParams(writeFiltersToSearchParams(merged), { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per preset+tags ready
  }, [presetParam, options.tagsReady])
}
