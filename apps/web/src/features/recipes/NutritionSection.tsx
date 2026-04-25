import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ApiError, NutritionEstimate } from '@shared-cookbook/shared'
import { useUpdateRecipeNutrition } from './hooks'

interface NutritionSectionProps {
  recipeId: string
  nutrition: NutritionEstimate | null
  /** Pencil affordance only shows when true (author OR admin). */
  canEdit: boolean
}

/**
 * P2-10 "Nährwerte (geschätzt)" section on the recipe detail page.
 *
 * Renders four rows — Energie / Eiweiß / Kohlenhydrate / Fett — each
 * with an inline-edit pencil. Click-to-edit mirrors the AP1
 * displayname-edit pattern in `ProfilePage` for consistency.
 *
 * When `nutrition` is `null` and the viewer can't edit, nothing
 * renders — the caller hides the whole section. When `null` but the
 * viewer is author/admin, a tiny affordance still surfaces (plus-style)
 * so they can add an estimate manually. Matches the plan's
 * "empty/null → section hidden entirely" for the read-only viewer case.
 */
export function NutritionSection({
  recipeId,
  nutrition,
  canEdit,
}: NutritionSectionProps) {
  const { t } = useTranslation()
  // Hide entirely for viewers without an estimate + without edit
  // rights. Authors/admins with no estimate still see the "add"
  // affordance so they can kick off an edit.
  if (!nutrition && !canEdit) return null

  return (
    <section className="mt-7" aria-labelledby="nutrition-heading">
      <h2
        id="nutrition-heading"
        className="mb-3.5 font-serif text-[24px] font-semibold tracking-[-0.005em] text-foreground"
      >
        {t('recipes.nutrition.heading', { defaultValue: 'Nährwerte' })}{' '}
        <span className="ml-2 inline-flex items-center rounded-full bg-[hsl(var(--muted))] px-2 py-[2px] text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          {t('recipes.nutrition.estimatedChip', { defaultValue: 'geschätzt' })}
        </span>
        <span className="ml-2 text-[12px] font-normal text-[hsl(var(--muted-foreground))]">
          {t('recipes.nutrition.perPortion', { defaultValue: 'pro Portion' })}
        </span>
      </h2>

      {nutrition ? (
        <ul className="space-y-2">
          <NutritionRow
            label={t('recipes.nutrition.energy', { defaultValue: 'Energie' })}
            unit="kcal"
            value={nutrition.kcal}
            max={5000}
            recipeId={recipeId}
            field="kcal"
            canEdit={canEdit}
            nutrition={nutrition}
          />
          <NutritionRow
            label={t('recipes.nutrition.protein', { defaultValue: 'Eiweiß' })}
            unit="g"
            value={nutrition.proteinG}
            max={500}
            recipeId={recipeId}
            field="proteinG"
            canEdit={canEdit}
            nutrition={nutrition}
          />
          <NutritionRow
            label={t('recipes.nutrition.carbs', {
              defaultValue: 'Kohlenhydrate',
            })}
            unit="g"
            value={nutrition.carbsG}
            max={500}
            recipeId={recipeId}
            field="carbsG"
            canEdit={canEdit}
            nutrition={nutrition}
          />
          <NutritionRow
            label={t('recipes.nutrition.fat', { defaultValue: 'Fett' })}
            unit="g"
            value={nutrition.fatG}
            max={500}
            recipeId={recipeId}
            field="fatG"
            canEdit={canEdit}
            nutrition={nutrition}
          />
        </ul>
      ) : (
        <p className="text-[14px] italic text-[hsl(var(--muted-foreground))]">
          {t('recipes.nutrition.missing', {
            defaultValue: 'Noch keine Nährwert-Schätzung hinterlegt.',
          })}
        </p>
      )}
    </section>
  )
}

// ── Editable row ─────────────────────────────────────────────────────

interface NutritionRowProps {
  label: string
  unit: string
  value: number
  max: number
  recipeId: string
  field: keyof NutritionEstimate
  canEdit: boolean
  nutrition: NutritionEstimate
}

function NutritionRow({
  label,
  unit,
  value,
  max,
  recipeId,
  field,
  canEdit,
  nutrition,
}: NutritionRowProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(String(value))
  const [error, setError] = useState<string | null>(null)
  const mutation = useUpdateRecipeNutrition(recipeId)

  function enterEdit() {
    setDraft(String(value))
    setError(null)
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setError(null)
  }

  async function save() {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setError(
        t('recipes.nutrition.errors.notInteger', {
          defaultValue: 'Bitte eine ganze Zahl eingeben.',
        }),
      )
      return
    }
    if (parsed < 0 || parsed > max) {
      setError(
        t('recipes.nutrition.errors.rangeTemplate', {
          max,
          defaultValue: `Wert muss zwischen 0 und ${max} liegen.`,
        }),
      )
      return
    }
    try {
      await mutation.mutateAsync({ ...nutrition, [field]: parsed })
      setEditing(false)
      setError(null)
    } catch (err) {
      const apiErr = err as Partial<ApiError>
      setError(
        apiErr.message ??
          t('recipes.nutrition.errors.saveFailed', {
            defaultValue: 'Speichern fehlgeschlagen.',
          }),
      )
    }
  }

  if (!editing) {
    return (
      <li className="flex items-center gap-3 text-[15px]">
        <span className="w-[140px] shrink-0 text-[hsl(var(--muted-foreground))]">
          {label}
        </span>
        <span className="font-medium text-foreground">
          {value} {unit}
        </span>
        {canEdit && (
          <button
            type="button"
            onClick={enterEdit}
            aria-label={t('recipes.nutrition.editAria', {
              label,
              defaultValue: `${label} bearbeiten`,
            })}
            className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </li>
    )
  }

  return (
    <li>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        className="flex flex-wrap items-center gap-2 text-[15px]"
        aria-label={t('recipes.nutrition.editAria', {
          label,
          defaultValue: `${label} bearbeiten`,
        })}
      >
        <label
          htmlFor={`nutrition-${field}-input`}
          className="w-[140px] shrink-0 text-[hsl(var(--muted-foreground))]"
        >
          {label}
        </label>
        <input
          id={`nutrition-${field}-input`}
          // text (not number) on purpose: the number type strips / rounds
          // values that fall outside the [min,max] attrs on some engines,
          // which would prevent our explicit bounds check from surfacing
          // the "Wert muss zwischen 0 und N liegen" message. We do the
          // range check in save() instead.
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          className="w-[90px] rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span className="text-[hsl(var(--muted-foreground))]">{unit}</span>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {t('recipes.nutrition.submitCta', { defaultValue: 'Speichern' })}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={mutation.isPending}
          className="rounded-md border border-input px-2 py-1 text-xs font-medium hover:bg-accent"
        >
          {t('recipes.nutrition.cancelCta', { defaultValue: 'Abbrechen' })}
        </button>
        {error && (
          <p role="alert" className="w-full text-xs text-[hsl(var(--destructive))]">
            {error}
          </p>
        )}
      </form>
    </li>
  )
}
