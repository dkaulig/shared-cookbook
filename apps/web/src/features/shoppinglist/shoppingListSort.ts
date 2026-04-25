import type {
  IngredientCategory,
  ShoppingListItemDto,
} from '@shared-cookbook/shared'
import { CATEGORY_ORDER } from './categoryLabels'

/**
 * One category bucket — the category key plus the items ordered
 * according to the backend's `sortOrder` (the aggregator already
 * assigned a deterministic ascending order per category in P3-6).
 */
export interface CategoryBucket {
  category: IngredientCategory
  items: readonly ShoppingListItemDto[]
}

/**
 * Groups `items` by `category` and returns them in the canonical
 * `CATEGORY_ORDER` sequence. Empty categories are dropped so the UI
 * doesn't render a headline with no rows underneath it.
 *
 * Within a bucket we sort by `sortOrder` ascending — the backend
 * (`ShoppingListGenerator`) assigns this deterministically and
 * alphabetically within a category; any tie is broken by `name` +
 * `id` so the output is stable across renders.
 */
export function byCategory(
  items: readonly ShoppingListItemDto[],
): CategoryBucket[] {
  const map = new Map<IngredientCategory, ShoppingListItemDto[]>()
  for (const item of items) {
    const bucket = map.get(item.category)
    if (bucket) {
      bucket.push(item)
    } else {
      map.set(item.category, [item])
    }
  }

  const buckets: CategoryBucket[] = []
  for (const category of CATEGORY_ORDER) {
    const bucketItems = map.get(category)
    if (!bucketItems || bucketItems.length === 0) continue
    const sorted = [...bucketItems].sort(compareBySortOrderThenName)
    buckets.push({ category, items: sorted })
  }
  return buckets
}

/**
 * Flattens `items` into a single list sorted alphabetically by name
 * using locale-aware, case-insensitive comparison. Defaults to the
 * German locale so umlauts sort next to their base letter ("Äpfel"
 * before "Banane", "Möhre" before "Nudeln").
 *
 * Tie-break by `id` keeps the output stable for equal names.
 */
export function byName(
  items: readonly ShoppingListItemDto[],
  locale: string | string[] = 'de',
): ShoppingListItemDto[] {
  const collator = new Intl.Collator(locale, {
    sensitivity: 'base',
    numeric: true,
  })
  return [...items].sort((a, b) => {
    const cmp = collator.compare(a.name, b.name)
    if (cmp !== 0) return cmp
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

function compareBySortOrderThenName(
  a: ShoppingListItemDto,
  b: ShoppingListItemDto,
): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  // `localeCompare` here is fine — same-bucket items share a category,
  // so German locale is the only one we need to care about for
  // umlaut sorting. The `byName` path uses a cached collator because
  // it runs over potentially the full list.
  const cmp = a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })
  if (cmp !== 0) return cmp
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
