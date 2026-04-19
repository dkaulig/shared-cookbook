/**
 * Step between consecutive `sortOrder` values in a freshly reindexed
 * bucket. Picked at 10 (not 1) so later phases can insert a slot
 * between two neighbours without a global reindex: drop between 0
 * and 10 → `5`. P3-3 always reindexes the full bucket for simplicity,
 * but the spacing is in place.
 */
export const SORT_ORDER_STEP = 10
