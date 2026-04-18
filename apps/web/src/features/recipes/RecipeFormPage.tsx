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
import { GripVertical, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGroup } from '@/features/groups/hooks'
import { CreateTagDialog } from '@/features/tagManagement/CreateTagDialog'
import {
  useCreateRecipe,
  useGroupTags,
  useRecipe,
  useUpdateRecipe,
} from './hooks'
import { CharCounter } from './CharCounter'
import { DifficultyPills } from './DifficultyPills'
import type { DifficultyLevel } from './DifficultyPills'
import { FormActionBar } from './FormActionBar'
import { FormIntro } from './FormIntro'
import { PhotoUploadGrid } from './PhotoUploadGrid'
import { RecipeFormTopNav } from './RecipeFormTopNav'

const UNITS = [
  'g',
  'kg',
  'ml',
  'l',
  'EL',
  'TL',
  'Stück',
  'Prise',
  'Bund',
  'Tasse',
  'Becher',
  'Scheibe',
  'Zehe',
  'nach Geschmack',
]

const CATEGORY_ORDER: readonly TagCategory[] = [
  'Mahlzeit',
  'Saison',
  'Typ',
  'Aufwand',
  'Diaet',
  'Kueche',
  // GR1 — Grundrezept-Tags for isolated sub-recipes. Rendered as its
  // own section between the predefined categories and the user-created
  // Custom block.
  'Komponente',
  'Custom',
]

const CATEGORY_LABELS: Record<TagCategory, string> = {
  Mahlzeit: 'Mahlzeit',
  Saison: 'Saison',
  Typ: 'Typ',
  Aufwand: 'Aufwand',
  Diaet: 'Diät',
  Kueche: 'Küche',
  Komponente: 'Komponente',
  Custom: 'Gruppen-Tags (Custom)',
}

const TITLE_MAX = 200
const DESC_MAX = 2000

type IngredientRow = {
  key: string
  quantity: string
  unit: string
  name: string
  note: string
  scalable: boolean
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
    return (
      <main className="mx-auto max-w-3xl px-6 py-10 text-[hsl(var(--muted-foreground))]">
        Lade Rezept …
      </main>
    )
  }

  if (mode === 'edit' && (recipeQuery.isError || !recipeQuery.data)) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p
          role="alert"
          className="rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
        >
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

  const groupQuery = useGroup(groupId)
  const tagsQuery = useGroupTags(groupId)
  const createMutation = useCreateRecipe(groupId)
  const updateMutation = useUpdateRecipe(recipeId, groupId)

  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [defaultServings, setDefaultServings] = useState(initial?.defaultServings ?? 4)
  const [prepTime, setPrepTime] = useState(
    initial?.prepTimeMinutes != null ? String(initial.prepTimeMinutes) : '',
  )
  const [difficulty, setDifficulty] = useState<DifficultyLevel>(
    ((initial?.difficulty as DifficultyLevel) ?? 1),
  )
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
  const [createTagOpen, setCreateTagOpen] = useState(false)
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

  function handleStepDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setSteps((prev) => {
      const oldIndex = prev.findIndex((r) => r.key === active.id)
      const newIndex = prev.findIndex((r) => r.key === over.id)
      if (oldIndex < 0 || newIndex < 0) return prev
      return arrayMove(prev, oldIndex, newIndex)
    })
  }

  function cancel() {
    navigate(`/groups/${groupId}`)
  }

  async function handleSubmit(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault()
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
      const trimmed = row.quantity.trim()
      // "nach Geschmack" is a unit convention that always implies a null
      // quantity (the renderer shows italic "nach Geschmack" text and
      // the scaler skips the row).
      const noQty = trimmed === '' || row.unit === 'nach Geschmack'
      const quantity = noQty ? null : Number(trimmed)
      return {
        position: idx,
        quantity,
        unit: row.unit.trim(),
        name: row.name.trim(),
        note: row.note.trim() === '' ? undefined : row.note.trim(),
        // scaleIngredients() throws on 0/negative quantities — a missing
        // quantity auto-flips scalable off so the downstream math is safe.
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
      // DS5 handoff: scaleIngredients() throws on 0/negative, so clamp
      // the persisted default-servings to ≥ 1 regardless of what the
      // user typed.
      defaultServings: Math.max(1, defaultServings),
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
  const hasCustomCategory = tagsByCategory.has('Custom')

  return (
    <>
      <RecipeFormTopNav mode={mode} onCancel={cancel} />

      <main className="relative mx-auto max-w-3xl px-5 pb-40 pt-5 md:px-8 md:pt-7">
        <FormIntro mode={mode} groupName={groupQuery.data?.name} />

        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          {/* ── Grunddaten ─────────────────────────────────────── */}
          <FormCard
            title="Grunddaten"
            description="Titel und eine kurze Beschreibung, damit andere das Rezept wiedererkennen."
          >
            <Field htmlFor="recipe-title" label="Titel">
              <FormInput
                id="recipe-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={TITLE_MAX}
                placeholder="z.B. Mamas Apfelkuchen"
                required
              />
              <CharCounter value={title} max={TITLE_MAX} />
            </Field>

            <Field
              htmlFor="recipe-description"
              label="Beschreibung"
              optional
              className="mt-[14px]"
            >
              <FormTextarea
                id="recipe-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={DESC_MAX}
                placeholder="Ein Satz oder zwei zur Einordnung …"
              />
              <CharCounter value={description} max={DESC_MAX} />
            </Field>
          </FormCard>

          {/* ── Fotos ─────────────────────────────────────────── */}
          {mode === 'edit' && initial ? (
            <FormCard
              title="Fotos"
              description="Bis zu 3 Bilder, je max. 5 MB. JPG, PNG oder WebP."
            >
              <PhotoUploadGrid recipeId={recipeId} photos={initial.photos} />
            </FormCard>
          ) : (
            <FormCard
              title="Fotos"
              description="Fotos kannst du nach dem ersten Speichern hinzufügen — bis zu 3 Bilder pro Rezept."
            >
              <div className="grid grid-cols-3 gap-2.5">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    aria-hidden="true"
                    className="flex aspect-square items-center justify-center rounded-[12px] border-2 border-dashed border-[hsl(var(--input))] bg-[hsl(var(--muted))] text-[11px] text-[hsl(var(--muted-foreground))]"
                  >
                    nach dem Speichern
                  </div>
                ))}
              </div>
            </FormCard>
          )}

          {/* ── Details ──────────────────────────────────────── */}
          <FormCard title="Details" description="Portionen, Zubereitungszeit, Schwierigkeit.">
            <div className="grid grid-cols-2 gap-3">
              <Field htmlFor="recipe-servings" label="Portionen">
                <FormInput
                  id="recipe-servings"
                  type="number"
                  min={1}
                  max={99}
                  value={defaultServings}
                  onChange={(e) =>
                    setDefaultServings(Math.max(1, Number(e.target.value) || 1))
                  }
                />
              </Field>
              <Field htmlFor="recipe-prep" label="Dauer (Min)">
                <FormInput
                  id="recipe-prep"
                  type="number"
                  min={1}
                  max={600}
                  value={prepTime}
                  onChange={(e) => setPrepTime(e.target.value)}
                  placeholder="45"
                />
              </Field>
            </div>

            <Field
              htmlFor="recipe-difficulty"
              label="Schwierigkeit"
              className="mt-[14px]"
            >
              <DifficultyPills value={difficulty} onChange={setDifficulty} />
            </Field>

            <Field
              htmlFor="recipe-source"
              label="Quelle (URL)"
              optional
              className="mt-[14px]"
            >
              <FormInput
                id="recipe-source"
                type="url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://… — z.B. Foodblog oder Reel-Link"
              />
            </Field>
          </FormCard>

          {/* ── Zutaten ───────────────────────────────────────── */}
          <FormCard
            title="Zutaten"
            description="Reihenfolge per Griff ziehen. Bei „nach Geschmack“ skalieren wir nicht mit."
          >
            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleIngredientDragEnd}
            >
              <SortableContext
                items={ingredients.map((r) => r.key)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="flex flex-col gap-2">
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
            <AddRowButton
              onClick={() => setIngredients((prev) => [...prev, emptyIngredient()])}
              label="Zutat hinzufügen"
            />
          </FormCard>

          {/* ── Zubereitung ────────────────────────────────────── */}
          <FormCard
            title="Zubereitung"
            description="Schrittweise. Reihenfolge per Griff umsortierbar."
          >
            {/*
              Two independent DndContexts (one for ingredients, one for
              steps) keep collision detection scoped per list so a
              dragged ingredient can never land in the step list.
            */}
            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleStepDragEnd}
            >
              <SortableContext
                items={steps.map((r) => r.key)}
                strategy={verticalListSortingStrategy}
              >
                <ol className="flex flex-col gap-2">
                  {steps.map((row, index) => (
                    <SortableStepRow
                      key={row.key}
                      row={row}
                      index={index}
                      canRemove={steps.length > 1}
                      onChange={(content) => updateStep(index, content)}
                      onRemove={() =>
                        setSteps((prev) =>
                          prev.length > 1 ? prev.filter((_, i) => i !== index) : prev,
                        )
                      }
                    />
                  ))}
                </ol>
              </SortableContext>
            </DndContext>
            <AddRowButton
              onClick={() => setSteps((prev) => [...prev, emptyStep()])}
              label="Schritt hinzufügen"
            />
          </FormCard>

          {/* ── Tags ──────────────────────────────────────────── */}
          <FormCard
            title="Tags"
            description="Tagge das Rezept für Filter und „Was kochen wir heute?“"
          >
            {tagsQuery.isLoading ? (
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Lade Tags …</p>
            ) : (
              <div className="space-y-3.5">
                {CATEGORY_ORDER.filter((c) => tagsByCategory.has(c)).map((category, i) => (
                  <div
                    key={category}
                    className={cn(
                      i > 0 && 'border-t border-dashed border-border pt-3.5',
                    )}
                  >
                    <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
                      {CATEGORY_LABELS[category]}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(tagsByCategory.get(category) ?? []).map((tag) => (
                        <TagChip
                          key={tag.id}
                          label={tag.name}
                          selected={selectedTagIds.includes(tag.id)}
                          onToggle={() => toggleTag(tag.id)}
                        />
                      ))}
                      {category === 'Custom' && (
                        <CustomTagButton onClick={() => setCreateTagOpen(true)} />
                      )}
                    </div>
                  </div>
                ))}
                {!hasCustomCategory && (
                  <div className="border-t border-dashed border-border pt-3.5">
                    <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
                      {CATEGORY_LABELS.Custom}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <CustomTagButton onClick={() => setCreateTagOpen(true)} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </FormCard>

          {error && (
            <p
              role="alert"
              className="rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
            >
              {error}
            </p>
          )}

          {/* Hidden submit keeps Enter-to-submit working on inputs. The
              visible submit lives in the sticky action bar. */}
          <button type="submit" className="sr-only" aria-hidden="true" tabIndex={-1}>
            Rezept speichern
          </button>
        </form>

        {createTagOpen && (
          <CreateTagDialog groupId={groupId} onClose={() => setCreateTagOpen(false)} />
        )}
      </main>

      <FormActionBar
        mode={mode}
        pending={isPending}
        onCancel={cancel}
        onSubmit={() => void handleSubmit()}
      />
    </>
  )
}

// ── Card / field primitives ──────────────────────────────────────────

function FormCard({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[18px] border border-border bg-card px-5 pb-5 pt-[18px] shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
      <h2 className="mb-1 font-serif text-[20px] font-semibold tracking-[-0.005em] text-foreground">
        {title}
      </h2>
      <p className="mb-3.5 text-[13px] leading-[1.45] text-[hsl(var(--muted-foreground))]">
        {description}
      </p>
      {children}
    </section>
  )
}

function Field({
  htmlFor,
  label,
  optional,
  className,
  children,
}: {
  htmlFor: string
  label: string
  optional?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={htmlFor}
        className="flex items-center gap-1.5 text-[13px] font-semibold tracking-[0.01em] text-foreground"
      >
        {label}
        {optional && (
          <span className="text-[12px] font-normal text-[hsl(var(--muted-foreground))]">
            optional
          </span>
        )}
      </label>
      {children}
    </div>
  )
}

function FormInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'w-full rounded-[12px] border border-[hsl(var(--input))] bg-background px-[13px] py-[11px] text-[15px] leading-[1.4] text-foreground transition-[border-color,box-shadow,background-color] duration-150',
        'placeholder:text-[hsl(var(--muted-foreground))]/80',
        'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25 focus-visible:bg-card',
        'disabled:cursor-not-allowed disabled:opacity-50',
        props.className,
      )}
    />
  )
}

function FormTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        'min-h-[72px] w-full rounded-[12px] border border-[hsl(var(--input))] bg-background px-[13px] py-[11px] text-[15px] leading-[1.4] text-foreground transition-[border-color,box-shadow,background-color] duration-150',
        'placeholder:text-[hsl(var(--muted-foreground))]/80',
        'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25 focus-visible:bg-card',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'resize-y',
        props.className,
      )}
    />
  )
}

function FormSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'w-full appearance-none rounded-[12px] border border-[hsl(var(--input))] bg-card px-[13px] py-[11px] pr-9 text-[14px] leading-[1.4] text-foreground transition-[border-color,box-shadow,background-color] duration-150',
        'bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20width%3D%2714%27%20height%3D%2714%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%2357534e%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpolyline%20points%3D%276%209%2012%2015%2018%209%27/%3E%3C/svg%3E")] bg-[right_12px_center] bg-no-repeat',
        'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25',
        props.className,
      )}
    />
  )
}

// ── Add-row + tag chips ──────────────────────────────────────────────

function AddRowButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'mt-2 inline-flex w-full items-center justify-center gap-2 rounded-[12px] border border-dashed border-[hsl(var(--input))] bg-transparent px-4 py-[11px] text-[14px] font-medium text-[hsl(var(--muted-foreground))]',
        'transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary',
      )}
    >
      <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
      {label}
    </button>
  )
}

function TagChip({
  label,
  selected,
  onToggle,
}: {
  label: string
  selected: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-[5px] text-[13px] transition-colors',
        selected
          ? 'border-primary bg-primary text-[hsl(var(--primary-foreground))]'
          : 'border-[hsl(var(--input))] bg-transparent text-[hsl(var(--muted-foreground))] hover:border-primary hover:text-primary',
      )}
    >
      {label}
    </button>
  )
}

function CustomTagButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-[hsl(var(--input))] bg-transparent px-2.5 py-[5px] text-[13px] text-[hsl(var(--muted-foreground))] transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary"
    >
      <Plus className="h-3 w-3" aria-hidden="true" />
      Neuen Tag erstellen
    </button>
  )
}

// ── Ingredient row ───────────────────────────────────────────────────

/**
 * Sortable ingredient row — preserves the S3 drag-drop wiring:
 * the drag-handle button carries the @dnd-kit listeners/attributes,
 * including the keyboard-sensor coordinate getter so Space + ArrowUp/Down
 * reorder rows without a mouse.
 *
 * Visual shell mirrors `.drag-row` + `.ing-body` in the mockup:
 *   [handle] [qty | unit-select | name ] [scalable | X]
 *   [                 note-row                      ]
 *
 * `scalable` auto-disables whenever `quantity` is blank because the
 * scaler math (scaleIngredients) throws on null/0 quantities.
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
    opacity: isDragging ? 0.85 : 1,
  }
  const hasQty = row.quantity.trim().length > 0
  const scalableEffective = hasQty && row.scalable

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'grid grid-cols-[28px_1fr_auto] items-start gap-2 rounded-[12px] border border-border bg-[hsl(var(--muted))] py-2.5 pl-1 pr-2.5 transition-colors',
        isDragging && 'border-primary bg-[hsl(var(--primary)/0.08)] shadow-[0_8px_24px_-8px_rgba(146,64,14,0.14)]',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        data-testid={`ingredient-drag-handle-${index}`}
        aria-label="Zutat verschieben"
        className="grid h-10 min-h-[40px] w-7 place-items-center rounded-md text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:cursor-grabbing"
        style={{ touchAction: 'none', cursor: 'grab' }}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <div className="grid grid-cols-[92px_96px_1fr] items-start gap-1.5">
        <FormInput
          type="text"
          inputMode="decimal"
          value={row.quantity}
          onChange={(e) => onUpdate(index, (r) => ({ ...r, quantity: e.target.value }))}
          placeholder="Menge"
          aria-label={`Zutat ${index + 1} Menge`}
          className="py-2 text-right text-[14px]"
        />
        <FormSelect
          value={row.unit}
          onChange={(e) => onUpdate(index, (r) => ({ ...r, unit: e.target.value }))}
          aria-label={`Zutat ${index + 1} Einheit`}
          className="py-2 text-[14px]"
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </FormSelect>
        <FormInput
          type="text"
          value={row.name}
          onChange={(e) => onUpdate(index, (r) => ({ ...r, name: e.target.value }))}
          placeholder="Zutat"
          aria-label={`Zutat ${index + 1} Name`}
          className="py-2 text-[14px]"
        />
        <div className="col-span-3 mt-1">
          <FormInput
            type="text"
            value={row.note}
            onChange={(e) => onUpdate(index, (r) => ({ ...r, note: e.target.value }))}
            placeholder="Notiz (optional), z.B. „fein gehackt“"
            aria-label={`Zutat ${index + 1} Notiz`}
            className="py-1.5 text-[12px]"
          />
        </div>
      </div>

      <div className="flex flex-col items-center gap-1.5 pt-1">
        <button
          type="button"
          onClick={() =>
            onUpdate(index, (r) => ({ ...r, scalable: !r.scalable }))
          }
          disabled={!hasQty}
          aria-pressed={scalableEffective}
          aria-label={`Zutat ${index + 1} skalieren`}
          className={cn(
            'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-1 text-[11px] font-medium transition-colors',
            scalableEffective
              ? 'border-transparent bg-[hsl(var(--secondary))] text-[hsl(var(--primary-hover,var(--primary)))]'
              : 'border-[hsl(var(--input))] bg-transparent text-[hsl(var(--muted-foreground))]',
            !hasQty && 'cursor-not-allowed opacity-60',
            hasQty && 'hover:border-[hsl(var(--primary-hover,var(--primary)))]',
          )}
        >
          {scalableEffective ? 'skalierbar' : 'nicht skalieren'}
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Zutat entfernen"
          className={cn(
            'grid h-6 w-6 place-items-center rounded-md text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--destructive)/0.08)] hover:text-[hsl(var(--destructive))]',
            !canRemove && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-[hsl(var(--muted-foreground))]',
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </li>
  )
}

// ── Step row ─────────────────────────────────────────────────────────

/**
 * Sortable step row — same pattern as SortableIngredientRow. The drag
 * handle button carries the @dnd-kit listeners so Space + ArrowUp/Down
 * reorder without a mouse.
 *
 * Visual shell mirrors `.drag-row` + `.step-body` in the mockup:
 *   [handle] [step-num serif avatar + "Schritt N" label + textarea] [X]
 */
function SortableStepRow({
  row,
  index,
  canRemove,
  onChange,
  onRemove,
}: {
  row: StepRow
  index: number
  canRemove: boolean
  onChange: (content: string) => void
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
    opacity: isDragging ? 0.85 : 1,
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'grid grid-cols-[28px_1fr_auto] items-start gap-2 rounded-[12px] border border-border bg-[hsl(var(--muted))] py-2.5 pl-1 pr-2.5 transition-colors',
        isDragging && 'border-primary bg-[hsl(var(--primary)/0.08)] shadow-[0_8px_24px_-8px_rgba(146,64,14,0.14)]',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        data-testid={`step-drag-handle-${index}`}
        aria-label="Schritt verschieben"
        className="grid h-10 min-h-[40px] w-7 place-items-center rounded-md text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:cursor-grabbing"
        style={{ touchAction: 'none', cursor: 'grab' }}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <div
            aria-hidden="true"
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-primary font-serif text-[13px] font-bold text-[hsl(var(--primary-foreground))]"
          >
            {index + 1}
          </div>
          <span className="text-[13px] font-semibold text-[hsl(var(--muted-foreground))]">
            Schritt {index + 1}
          </span>
        </div>
        <FormTextarea
          value={row.content}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Was wird in diesem Schritt gemacht?"
          aria-label={`Schritt ${index + 1}`}
          maxLength={5000}
          className="min-h-[52px] text-[14px]"
        />
      </div>

      <div className="flex items-start pt-1">
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Schritt entfernen"
          className={cn(
            'grid h-6 w-6 place-items-center rounded-md text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--destructive)/0.08)] hover:text-[hsl(var(--destructive))]',
            !canRemove && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-[hsl(var(--muted-foreground))]',
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </li>
  )
}
