import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type {
  ApiError,
  CreateRecipeRequest,
  IngredientDto,
  RecipeDetailDto,
  RecipeStepDto,
  TagCategory,
  TagDto,
} from '@familien-kochbuch/shared'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  useCreateRecipe,
  useGroupTags,
  useRecipe,
  useUpdateRecipe,
} from './hooks'
import { PhotoUploader } from './PhotoUploader'

const UNITS = ['g', 'kg', 'ml', 'l', 'EL', 'TL', 'Stück', 'Prise', 'Bund', 'Tasse', 'Becher', 'Scheibe', 'Zehe']

const CATEGORY_LABELS: Record<TagCategory, string> = {
  Mahlzeit: 'Mahlzeit',
  Saison: 'Saison',
  Typ: 'Typ',
  Aufwand: 'Aufwand',
  Diaet: 'Diät',
  Kueche: 'Küche',
  Custom: 'Eigene',
}

type IngredientRow = {
  key: string
  quantity: string
  unit: string
  name: string
  note: string
  scalable: boolean
  quantityNull: boolean
}

type StepRow = {
  key: string
  content: string
}

function emptyIngredient(): IngredientRow {
  return {
    key: crypto.randomUUID(),
    quantity: '',
    unit: 'g',
    name: '',
    note: '',
    scalable: true,
    quantityNull: false,
  }
}

function emptyStep(): StepRow {
  return { key: crypto.randomUUID(), content: '' }
}

function ingredientFromDto(i: IngredientDto): IngredientRow {
  return {
    key: i.id ?? crypto.randomUUID(),
    quantity: i.quantity == null ? '' : String(i.quantity),
    unit: i.unit,
    name: i.name,
    note: i.note ?? '',
    scalable: i.scalable,
    quantityNull: i.quantity == null,
  }
}

function stepFromDto(s: RecipeStepDto): StepRow {
  return { key: s.id ?? crypto.randomUUID(), content: s.content }
}

type Props = {
  mode: 'create' | 'edit'
}

/**
 * Wrapper: on edit we need the recipe loaded before rendering the inner
 * form, so we can initialise `useState` from the DTO on first render (no
 * setState-in-effect hack). Create mode skips the wait.
 */
export function RecipeFormPage({ mode }: Props) {
  const params = useParams<{ groupId: string; recipeId: string }>()
  const recipeId = params.recipeId ?? ''
  const recipeQuery = useRecipe(mode === 'edit' ? recipeId : undefined)

  if (mode === 'edit' && recipeQuery.isLoading) {
    return <main className="mx-auto max-w-3xl px-6 py-10 text-stone-500">Lade Rezept …</main>
  }

  if (mode === 'edit' && (recipeQuery.isError || !recipeQuery.data)) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          Rezept konnte nicht geladen werden.
        </p>
      </main>
    )
  }

  return <RecipeFormInner mode={mode} initial={mode === 'edit' ? recipeQuery.data! : undefined} />
}

function RecipeFormInner({
  mode,
  initial,
}: {
  mode: 'create' | 'edit'
  initial?: RecipeDetailDto
}) {
  const params = useParams<{ groupId: string; recipeId: string }>()
  const navigate = useNavigate()
  const groupId = params.groupId ?? ''
  const recipeId = params.recipeId ?? ''

  const tagsQuery = useGroupTags(groupId)
  const createMutation = useCreateRecipe(groupId)
  const updateMutation = useUpdateRecipe(recipeId, groupId)

  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [defaultServings, setDefaultServings] = useState(initial?.defaultServings ?? 4)
  const [prepTime, setPrepTime] = useState(
    initial?.prepTimeMinutes != null ? String(initial.prepTimeMinutes) : '',
  )
  const [difficulty, setDifficulty] = useState(initial?.difficulty ?? 1)
  const [sourceUrl, setSourceUrl] = useState(initial?.sourceUrl ?? '')
  const [ingredients, setIngredients] = useState<IngredientRow[]>(() =>
    initial && initial.ingredients.length > 0
      ? initial.ingredients.map(ingredientFromDto)
      : [emptyIngredient()],
  )
  const [steps, setSteps] = useState<StepRow[]>(() =>
    initial && initial.steps.length > 0 ? initial.steps.map(stepFromDto) : [emptyStep()],
  )
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(
    () => initial?.tags.map((t) => t.id) ?? [],
  )
  const [error, setError] = useState<string | null>(null)

  const tagsByCategory = useMemo(() => {
    const grouped = new Map<TagCategory, TagDto[]>()
    for (const tag of tagsQuery.data ?? []) {
      const cat = tag.category
      if (!grouped.has(cat)) grouped.set(cat, [])
      grouped.get(cat)!.push(tag)
    }
    return grouped
  }, [tagsQuery.data])

  // One shared sensor config for both the ingredient and the step DndContext.
  // PointerSensor covers mouse/touch; KeyboardSensor keeps reorder accessible.
  const dndSensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function updateIngredient(index: number, updater: (row: IngredientRow) => IngredientRow) {
    setIngredients((prev) => prev.map((row, i) => (i === index ? updater(row) : row)))
  }

  function updateStep(index: number, content: string) {
    setSteps((prev) => prev.map((row, i) => (i === index ? { ...row, content } : row)))
  }

  function toggleTag(id: string) {
    setSelectedTagIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]))
  }

  function handleIngredientDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setIngredients((prev) => {
      const oldIndex = prev.findIndex((r) => r.key === active.id)
      const newIndex = prev.findIndex((r) => r.key === over.id)
      if (oldIndex < 0 || newIndex < 0) return prev
      return arrayMove(prev, oldIndex, newIndex)
    })
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    if (title.trim().length === 0) {
      setError('Titel ist erforderlich.')
      return
    }
    const usableIngredients = ingredients.filter((i) => i.name.trim().length > 0)
    if (usableIngredients.length === 0) {
      setError('Mindestens eine Zutat ist erforderlich.')
      return
    }
    const usableSteps = steps.filter((s) => s.content.trim().length > 0)
    if (usableSteps.length === 0) {
      setError('Mindestens ein Schritt ist erforderlich.')
      return
    }

    const ingredientsPayload: IngredientDto[] = usableIngredients.map((row, idx) => {
      const quantity = row.quantityNull ? null : row.quantity.trim() === '' ? null : Number(row.quantity)
      return {
        position: idx,
        quantity,
        unit: row.unit.trim(),
        name: row.name.trim(),
        note: row.note.trim() === '' ? undefined : row.note.trim(),
        scalable: quantity == null ? false : row.scalable,
      }
    })

    const stepsPayload: RecipeStepDto[] = usableSteps.map((row, idx) => ({
      position: idx,
      content: row.content.trim(),
    }))

    const payload: CreateRecipeRequest = {
      title: title.trim(),
      description: description.trim() === '' ? undefined : description.trim(),
      defaultServings,
      prepTimeMinutes: prepTime.trim() === '' ? undefined : Number(prepTime),
      difficulty,
      sourceUrl: sourceUrl.trim() === '' ? undefined : sourceUrl.trim(),
      ingredients: ingredientsPayload,
      steps: stepsPayload,
      tagIds: selectedTagIds,
    }

    try {
      const result =
        mode === 'create'
          ? await createMutation.mutateAsync(payload)
          : await updateMutation.mutateAsync(payload)
      navigate(`/groups/${groupId}/recipes/${result.id}`)
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message || 'Rezept konnte nicht gespeichert werden.')
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <nav className="mb-4 text-sm text-stone-500">
        <button
          type="button"
          className="underline"
          onClick={() => navigate(`/groups/${groupId}`)}
        >
          ← Zur Gruppe
        </button>
      </nav>

      <h1 className="mb-6 text-3xl font-bold tracking-tight text-stone-900">
        {mode === 'create' ? 'Neues Rezept anlegen' : 'Rezept bearbeiten'}
      </h1>

      <form onSubmit={handleSubmit} className="space-y-6" noValidate>
        {/* Basics */}
        <section className="space-y-4 rounded-md bg-background p-4 ring-1 ring-border">
          <div className="space-y-1.5">
            <Label htmlFor="recipe-title">Titel</Label>
            <Input
              id="recipe-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recipe-description">Beschreibung</Label>
            <textarea
              id="recipe-description"
              className="min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="recipe-servings">Portionen</Label>
              <Input
                id="recipe-servings"
                type="number"
                min={1}
                value={defaultServings}
                onChange={(e) => setDefaultServings(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recipe-prep">Zubereitungszeit (Min)</Label>
              <Input
                id="recipe-prep"
                type="number"
                min={0}
                value={prepTime}
                onChange={(e) => setPrepTime(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recipe-difficulty">Schwierigkeit</Label>
              <select
                id="recipe-difficulty"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={difficulty}
                onChange={(e) => setDifficulty(Number(e.target.value))}
              >
                <option value={1}>1 – einfach</option>
                <option value={2}>2 – mittel</option>
                <option value={3}>3 – aufwendig</option>
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recipe-source">Quellen-Link (optional)</Label>
            <Input
              id="recipe-source"
              type="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
            />
          </div>
        </section>

        {/* Ingredients */}
        <section className="space-y-3 rounded-md bg-background p-4 ring-1 ring-border">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-stone-900">Zutaten</h2>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setIngredients((prev) => [...prev, emptyIngredient()])}
            >
              + Zutat hinzufügen
            </Button>
          </div>
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleIngredientDragEnd}
          >
            <SortableContext
              items={ingredients.map((r) => r.key)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="space-y-3">
                {ingredients.map((row, index) => (
                  <SortableIngredientRow
                    key={row.key}
                    row={row}
                    index={index}
                    canRemove={ingredients.length > 1}
                    onUpdate={updateIngredient}
                    onRemove={() =>
                      setIngredients((prev) =>
                        prev.length > 1 ? prev.filter((_, i) => i !== index) : prev,
                      )
                    }
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </section>

        {/* Steps */}
        <section className="space-y-3 rounded-md bg-background p-4 ring-1 ring-border">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-stone-900">Schritte</h2>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSteps((prev) => [...prev, emptyStep()])}
            >
              + Schritt hinzufügen
            </Button>
          </div>
          <ol className="space-y-3">
            {steps.map((row, index) => (
              <li key={row.key} className="flex gap-2">
                <div className="mt-8 text-sm font-semibold text-stone-600">{index + 1}.</div>
                <div className="flex-1">
                  <Label htmlFor={`step-${index}`} className="text-xs text-stone-600">
                    Beschreibung
                  </Label>
                  <textarea
                    id={`step-${index}`}
                    className="min-h-[90px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={row.content}
                    onChange={(e) => updateStep(index, e.target.value)}
                    aria-label={`Schritt ${index + 1}`}
                    maxLength={5000}
                  />
                </div>
                <div className="mt-8">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label="Schritt entfernen"
                    onClick={() =>
                      setSteps((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))
                    }
                  >
                    ✕
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Tags */}
        <section className="space-y-3 rounded-md bg-background p-4 ring-1 ring-border">
          <h2 className="text-lg font-semibold text-stone-900">Tags</h2>
          {Array.from(tagsByCategory.entries()).map(([category, tags]) => (
            <div key={category}>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
                {CATEGORY_LABELS[category]}
              </h3>
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => {
                  const selected = selectedTagIds.includes(tag.id)
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      className={
                        'rounded-full border px-3 py-1 text-xs transition-colors ' +
                        (selected
                          ? 'border-stone-900 bg-stone-900 text-white'
                          : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-100')
                      }
                    >
                      {tag.name}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </section>

        {/* Photos (only in edit mode — create first, then upload). */}
        {mode === 'edit' && initial && (
          <section className="space-y-3 rounded-md bg-background p-4 ring-1 ring-border">
            <h2 className="text-lg font-semibold text-stone-900">Fotos</h2>
            <PhotoUploader recipeId={recipeId} photos={initial.photos} />
          </section>
        )}

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => navigate(`/groups/${groupId}`)}>
            Abbrechen
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Speichern…' : 'Rezept speichern'}
          </Button>
        </div>
      </form>
    </main>
  )
}

/**
 * A single ingredient row that participates in the surrounding `DndContext`
 * via `useSortable`. The `GripVertical` button is the drag handle — it wires
 * the listeners/attributes from dnd-kit, including keyboard activation
 * (Space → ArrowUp/Down → Space) so reorder is accessible.
 */
function SortableIngredientRow({
  row,
  index,
  canRemove,
  onUpdate,
  onRemove,
}: {
  row: IngredientRow
  index: number
  canRemove: boolean
  onUpdate: (index: number, updater: (row: IngredientRow) => IngredientRow) => void
  onRemove: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.key })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="grid grid-cols-[auto_80px_120px_1fr_auto] gap-2 rounded-md bg-stone-50 p-3"
    >
      <div className="flex items-start pt-5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          data-testid={`ingredient-drag-handle-${index}`}
          aria-label="Zutat verschieben"
          className="cursor-grab rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
      </div>
      <div>
        <Label htmlFor={`ing-qty-${index}`} className="text-xs text-stone-600">
          Menge
        </Label>
        <Input
          id={`ing-qty-${index}`}
          type="text"
          inputMode="decimal"
          disabled={row.quantityNull}
          value={row.quantity}
          onChange={(e) => onUpdate(index, (r) => ({ ...r, quantity: e.target.value }))}
          aria-label={`Zutat ${index + 1} Menge`}
        />
      </div>
      <div>
        <Label htmlFor={`ing-unit-${index}`} className="text-xs text-stone-600">
          Einheit
        </Label>
        <select
          id={`ing-unit-${index}`}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
          value={row.unit}
          onChange={(e) => onUpdate(index, (r) => ({ ...r, unit: e.target.value }))}
          aria-label={`Zutat ${index + 1} Einheit`}
        >
          <option value="">—</option>
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor={`ing-name-${index}`} className="text-xs text-stone-600">
          Zutat
        </Label>
        <Input
          id={`ing-name-${index}`}
          type="text"
          value={row.name}
          onChange={(e) => onUpdate(index, (r) => ({ ...r, name: e.target.value }))}
          aria-label={`Zutat ${index + 1} Name`}
        />
        <div className="mt-1 flex items-center gap-4 text-xs text-stone-600">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={row.scalable}
              disabled={row.quantityNull}
              onChange={(e) => onUpdate(index, (r) => ({ ...r, scalable: e.target.checked }))}
            />
            skalierbar
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={row.quantityNull}
              onChange={(e) =>
                onUpdate(index, (r) => ({
                  ...r,
                  quantityNull: e.target.checked,
                  scalable: e.target.checked ? false : r.scalable,
                  quantity: e.target.checked ? '' : r.quantity,
                }))
              }
            />
            nach Geschmack
          </label>
          <Input
            type="text"
            placeholder="Notiz"
            className="h-7 max-w-[160px] text-xs"
            value={row.note}
            onChange={(e) => onUpdate(index, (r) => ({ ...r, note: e.target.value }))}
            aria-label={`Zutat ${index + 1} Notiz`}
          />
        </div>
      </div>
      <div className="flex items-end">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Zutat entfernen"
        >
          ✕
        </Button>
      </div>
    </li>
  )
}
