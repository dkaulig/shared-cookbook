import type {
  RecipeRevisionDetail,
  RecipeSnapshot,
  RecipeSnapshotIngredient,
  RecipeSnapshotStep,
} from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'

interface DiffModalProps {
  /** The historical revision the user picked. */
  previous: RecipeRevisionDetail
  /** Snapshot-shaped view of the current recipe. */
  current: RecipeSnapshot
  onClose: () => void
}

/**
 * Side-by-side diff modal for the S6 history panel. We deliberately
 * avoid a heavyweight diff library — a manual deep-compare on the small
 * snapshot shape produces a clear "what changed" view at zero bundle
 * cost. Highlighted rows carry `data-diff="changed"` so tests and
 * styles can target them.
 */
export function RecipeRevisionDiffModal({ previous, current, onClose }: DiffModalProps) {
  const previousSnapshot = previous.snapshot

  const ingredientLines = buildIngredientDiff(previousSnapshot.ingredients, current.ingredients)
  const stepLines = buildStepDiff(previousSnapshot.steps, current.steps)

  const titleChanged = previousSnapshot.title !== current.title
  const descriptionChanged = (previousSnapshot.description ?? '') !== (current.description ?? '')
  const servingsChanged = previousSnapshot.defaultServings !== current.defaultServings
  const prepChanged = (previousSnapshot.prepTimeMinutes ?? null) !== (current.prepTimeMinutes ?? null)
  const difficultyChanged = previousSnapshot.difficulty !== current.difficulty
  const sourceChanged = (previousSnapshot.sourceUrl ?? '') !== (current.sourceUrl ?? '')

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="revision-diff-heading"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/50 px-4"
    >
      <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-md bg-white p-6 shadow-xl">
        <header className="mb-4 flex items-start justify-between gap-2">
          <div>
            <h2 id="revision-diff-heading" className="text-xl font-semibold text-stone-900">
              Versionsvergleich
            </h2>
            <p className="text-sm text-stone-500">
              {previous.changedBy.displayName} · {new Date(previous.createdAt).toLocaleString('de-DE')}
            </p>
          </div>
          <Button type="button" variant="outline" onClick={onClose}>
            Schließen
          </Button>
        </header>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <SnapshotColumn label="Diese Version" snapshot={previousSnapshot} />
          <SnapshotColumn label="Aktuelles Rezept" snapshot={current} />
        </div>

        <section className="mt-6">
          <h3 className="mb-2 text-sm font-semibold text-stone-700">Metadaten</h3>
          <ul className="space-y-1 text-sm">
            <DiffRow label="Titel" changed={titleChanged}>
              <span className="text-stone-500">{previousSnapshot.title}</span>
              <span className="mx-2 text-stone-400">→</span>
              <span className="text-stone-900">{current.title}</span>
            </DiffRow>
            <DiffRow label="Beschreibung" changed={descriptionChanged}>
              <span className="text-stone-500">{previousSnapshot.description ?? '—'}</span>
              <span className="mx-2 text-stone-400">→</span>
              <span className="text-stone-900">{current.description ?? '—'}</span>
            </DiffRow>
            <DiffRow label="Standard-Portionen" changed={servingsChanged}>
              <span className="text-stone-500">{previousSnapshot.defaultServings}</span>
              <span className="mx-2 text-stone-400">→</span>
              <span className="text-stone-900">{current.defaultServings}</span>
            </DiffRow>
            <DiffRow label="Zubereitungszeit" changed={prepChanged}>
              <span className="text-stone-500">{previousSnapshot.prepTimeMinutes ?? '—'}</span>
              <span className="mx-2 text-stone-400">→</span>
              <span className="text-stone-900">{current.prepTimeMinutes ?? '—'}</span>
            </DiffRow>
            <DiffRow label="Schwierigkeit" changed={difficultyChanged}>
              <span className="text-stone-500">{previousSnapshot.difficulty}</span>
              <span className="mx-2 text-stone-400">→</span>
              <span className="text-stone-900">{current.difficulty}</span>
            </DiffRow>
            <DiffRow label="Quelle" changed={sourceChanged}>
              <span className="text-stone-500">{previousSnapshot.sourceUrl ?? '—'}</span>
              <span className="mx-2 text-stone-400">→</span>
              <span className="text-stone-900">{current.sourceUrl ?? '—'}</span>
            </DiffRow>
          </ul>
        </section>

        <section className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-stone-700">Zutaten (vorher)</h3>
            <ul className="space-y-1 text-sm">
              {ingredientLines.previous.map((line, idx) => (
                <li
                  key={`prev-ing-${idx}`}
                  data-diff={line.changed ? 'changed' : 'same'}
                  className={
                    line.changed
                      ? 'rounded bg-orange-50 px-2 py-0.5 text-stone-900 ring-1 ring-orange-200'
                      : 'px-2 py-0.5 text-stone-700'
                  }
                >
                  {line.label}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-stone-700">Zutaten (aktuell)</h3>
            <ul className="space-y-1 text-sm">
              {ingredientLines.current.map((line, idx) => (
                <li
                  key={`cur-ing-${idx}`}
                  data-diff={line.changed ? 'changed' : 'same'}
                  className={
                    line.changed
                      ? 'rounded bg-emerald-50 px-2 py-0.5 text-stone-900 ring-1 ring-emerald-200'
                      : 'px-2 py-0.5 text-stone-700'
                  }
                >
                  {line.label}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-stone-700">Schritte (vorher)</h3>
            <ol className="space-y-1 text-sm">
              {stepLines.previous.map((line, idx) => (
                <li
                  key={`prev-step-${idx}`}
                  data-diff={line.changed ? 'changed' : 'same'}
                  className={
                    line.changed
                      ? 'rounded bg-orange-50 px-2 py-0.5 text-stone-900 ring-1 ring-orange-200'
                      : 'px-2 py-0.5 text-stone-700'
                  }
                >
                  {line.label}
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-stone-700">Schritte (aktuell)</h3>
            <ol className="space-y-1 text-sm">
              {stepLines.current.map((line, idx) => (
                <li
                  key={`cur-step-${idx}`}
                  data-diff={line.changed ? 'changed' : 'same'}
                  className={
                    line.changed
                      ? 'rounded bg-emerald-50 px-2 py-0.5 text-stone-900 ring-1 ring-emerald-200'
                      : 'px-2 py-0.5 text-stone-700'
                  }
                >
                  {line.label}
                </li>
              ))}
            </ol>
          </div>
        </section>
      </div>
    </div>
  )
}

interface DiffRowProps {
  label: string
  changed: boolean
  children: React.ReactNode
}

function DiffRow({ label, changed, children }: DiffRowProps) {
  return (
    <li
      data-diff={changed ? 'changed' : 'same'}
      className={
        changed
          ? 'rounded bg-orange-50 px-2 py-1 ring-1 ring-orange-200'
          : 'px-2 py-1 text-stone-700'
      }
    >
      <span className="mr-2 inline-block min-w-[8rem] font-medium text-stone-900">{label}:</span>
      {children}
    </li>
  )
}

interface SnapshotColumnProps {
  label: string
  snapshot: RecipeSnapshot
}

function SnapshotColumn({ label, snapshot }: SnapshotColumnProps) {
  return (
    <div className="rounded-md border border-stone-200 p-3">
      <p className="mb-1 text-xs uppercase tracking-wide text-stone-500">{label}</p>
      <p className="text-base font-semibold text-stone-900">{snapshot.title}</p>
      <p className="mt-1 text-xs text-stone-500">
        {snapshot.ingredients.length} Zutaten · {snapshot.steps.length} Schritte ·{' '}
        {snapshot.defaultServings} Portionen
      </p>
    </div>
  )
}

interface DiffLine {
  label: string
  changed: boolean
}

interface DiffPair {
  previous: DiffLine[]
  current: DiffLine[]
}

function buildIngredientDiff(
  previous: RecipeSnapshotIngredient[],
  current: RecipeSnapshotIngredient[],
): DiffPair {
  const min = Math.min(previous.length, current.length)
  const previousLines: DiffLine[] = []
  const currentLines: DiffLine[] = []
  for (let i = 0; i < min; i++) {
    const p = previous[i]!
    const c = current[i]!
    const same = ingredientsEqual(p, c)
    previousLines.push({ label: formatIngredient(p), changed: !same })
    currentLines.push({ label: formatIngredient(c), changed: !same })
  }
  for (let i = min; i < previous.length; i++) {
    previousLines.push({ label: formatIngredient(previous[i]!), changed: true })
  }
  for (let i = min; i < current.length; i++) {
    currentLines.push({ label: formatIngredient(current[i]!), changed: true })
  }
  return { previous: previousLines, current: currentLines }
}

function buildStepDiff(
  previous: RecipeSnapshotStep[],
  current: RecipeSnapshotStep[],
): DiffPair {
  const min = Math.min(previous.length, current.length)
  const previousLines: DiffLine[] = []
  const currentLines: DiffLine[] = []
  for (let i = 0; i < min; i++) {
    const p = previous[i]!
    const c = current[i]!
    const same = p.content === c.content
    previousLines.push({ label: p.content, changed: !same })
    currentLines.push({ label: c.content, changed: !same })
  }
  for (let i = min; i < previous.length; i++) {
    previousLines.push({ label: previous[i]!.content, changed: true })
  }
  for (let i = min; i < current.length; i++) {
    currentLines.push({ label: current[i]!.content, changed: true })
  }
  return { previous: previousLines, current: currentLines }
}

function ingredientsEqual(
  a: RecipeSnapshotIngredient,
  b: RecipeSnapshotIngredient,
): boolean {
  return (
    a.position === b.position &&
    (a.quantity ?? null) === (b.quantity ?? null) &&
    a.unit === b.unit &&
    a.name === b.name &&
    (a.note ?? null) === (b.note ?? null) &&
    a.scalable === b.scalable
  )
}

function formatIngredient(i: RecipeSnapshotIngredient): string {
  const qty = i.quantity == null ? 'nach Geschmack' : `${i.quantity} ${i.unit}`.trim()
  return `${qty} ${i.name}`.trim()
}
