/**
 * COMP-2 — cross-component reorder helper extracted out of
 * {@link ./RecipeFormPage.tsx}. Lives in its own module so the
 * dnd-kit drag-end callback can call it during setState AND tests can
 * import the pure function without triggering React's fast-refresh
 * "component file exports non-component" warning.
 */

export interface ComponentLike<Row extends { key: string }> {
  ingredients: Row[]
  steps: Row[]
}

/**
 * COMP-2 — flatten `components[].(ingredients|steps)` into one array
 * keyed by component index + row index, move the active row to its
 * new slot (which may live in a different component), and re-shard
 * back into `components[]`. Fails safe (returns `prev`) when either
 * id doesn't resolve — prevents ghost drops from corrupting state.
 *
 * Split into two narrow helpers so TS can track the row type per
 * field without an intersection collapse.
 */
export function reorderAcrossComponents<
  Row extends { key: string },
  C extends ComponentLike<Row>,
>(
  prev: C[],
  field: 'ingredients' | 'steps',
  activeId: string | number,
  overId: string | number,
): C[] {
  if (field === 'ingredients') {
    return reorderFlat(
      prev,
      (c) => c.ingredients,
      (c, next) => ({ ...c, ingredients: next }),
      activeId,
      overId,
    )
  }
  return reorderFlat(
    prev,
    (c) => c.steps,
    (c, next) => ({ ...c, steps: next }),
    activeId,
    overId,
  )
}

function reorderFlat<Row extends { key: string }, C extends ComponentLike<Row>>(
  prev: C[],
  read: (c: C) => Row[],
  write: (c: C, next: Row[]) => C,
  activeId: string | number,
  overId: string | number,
): C[] {
  type FlatRow = { componentIndex: number; row: Row }
  const flat: FlatRow[] = []
  prev.forEach((c, ci) => {
    for (const row of read(c)) flat.push({ componentIndex: ci, row })
  })
  const fromIndex = flat.findIndex((f) => f.row.key === activeId)
  const toIndex = flat.findIndex((f) => f.row.key === overId)
  if (fromIndex < 0 || toIndex < 0) return prev

  const moved = flat[fromIndex]!
  const destComponentIndex = flat[toIndex]!.componentIndex

  // Remove the row, then re-insert at the destination slot. Semantics
  // mirror dnd-kit's `arrayMove(arr, from, to)`: item ends up at
  // index `to` in the post-move array. Same-position drops are
  // already filtered by the caller (active.id === over.id).
  const withoutMoved = flat.filter((_, i) => i !== fromIndex)
  withoutMoved.splice(toIndex, 0, {
    componentIndex: destComponentIndex,
    row: moved.row,
  })

  // Re-shard into per-component arrays.
  const buckets: Row[][] = prev.map(() => [])
  for (const entry of withoutMoved) {
    buckets[entry.componentIndex]!.push(entry.row)
  }
  return prev.map((c, ci) => write(c, buckets[ci]!))
}
