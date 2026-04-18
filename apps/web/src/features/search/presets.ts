import type { RecipeSearchParams, TagDto } from '@familien-kochbuch/shared'

/**
 * URL preset mapping for the DS3 Home quick-filter chips.
 *
 * The Home page (`apps/web/src/features/home/HomePage.tsx`) navigates the
 * user to `/groups/:id?preset=<name>`. The Group Detail page consumes
 * the preset once on entry and applies the matching filter(s), then
 * clears the URL param so a back/refresh doesn't re-apply.
 *
 * Preset → filter mapping:
 *   - quick   → maxPrepTime = 30 + tag "schnell" (Aufwand) if it exists
 *   - warm    → tag "warm" (Typ) if it exists
 *   - veggie  → tag "vegetarisch" (Diaet) if it exists
 *   - easy    → tag "schnell" (Aufwand) if it exists
 *   - season  → the Saison tag matching the current Northern-Hemisphere
 *               season (Frühling / Sommer / Herbst / Winter)
 *   - random  → signals the caller to run the random-pick flow; the
 *               filter state itself is not mutated
 */
export type FilterPreset = 'quick' | 'warm' | 'veggie' | 'easy' | 'season' | 'random'

const VALID_PRESETS: readonly FilterPreset[] = [
  'quick',
  'warm',
  'veggie',
  'easy',
  'season',
  'random',
] as const

export function isFilterPreset(value: string): value is FilterPreset {
  return (VALID_PRESETS as readonly string[]).includes(value)
}

/** Returns the German season label that matches `now`. */
export function currentSeasonTagName(now: Date = new Date()): 'Frühling' | 'Sommer' | 'Herbst' | 'Winter' {
  const month = now.getMonth() // 0 = January
  if (month === 11 || month === 0 || month === 1) return 'Winter'
  if (month >= 2 && month <= 4) return 'Frühling'
  if (month >= 5 && month <= 7) return 'Sommer'
  return 'Herbst'
}

/** Case-insensitive name match, trimmed. */
function findTagByName(tags: TagDto[], name: string): TagDto | undefined {
  const needle = name.trim().toLowerCase()
  return tags.find((t) => t.name.trim().toLowerCase() === needle)
}

function withTag(current: string[] | undefined, tagId: string): string[] {
  const set = new Set(current ?? [])
  set.add(tagId)
  return Array.from(set)
}

/**
 * Apply a URL preset to a filter state. Pure function; returns a new
 * object without mutating the input. When the matching tag isn't in the
 * group's tag pool, the preset no-ops on that leg (never throws).
 */
export function applyFilterPreset(
  input: RecipeSearchParams,
  preset: FilterPreset,
  tags: TagDto[],
  now: Date = new Date(),
): RecipeSearchParams {
  if (!isFilterPreset(preset)) return input

  switch (preset) {
    case 'quick': {
      const next: RecipeSearchParams = { ...input, maxPrepTime: 30 }
      const tag = findTagByName(tags, 'schnell')
      if (tag) next.tags = withTag(input.tags, tag.id)
      return next
    }
    case 'warm': {
      const tag = findTagByName(tags, 'warm')
      if (!tag) return { ...input }
      return { ...input, tags: withTag(input.tags, tag.id) }
    }
    case 'veggie': {
      const tag = findTagByName(tags, 'vegetarisch')
      if (!tag) return { ...input }
      return { ...input, tags: withTag(input.tags, tag.id) }
    }
    case 'easy': {
      const tag = findTagByName(tags, 'schnell')
      if (!tag) return { ...input }
      return { ...input, tags: withTag(input.tags, tag.id) }
    }
    case 'season': {
      const tag = findTagByName(tags, currentSeasonTagName(now))
      if (!tag) return { ...input }
      return { ...input, tags: withTag(input.tags, tag.id) }
    }
    case 'random':
      // Random triggers a navigation side-effect in the caller; the
      // filter state itself is untouched.
      return { ...input }
  }
}
