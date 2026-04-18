import { BookOpen, Users } from 'lucide-react'
import type { GroupDetail } from '@familien-kochbuch/shared'
import { cn } from '@/lib/utils'
import { getGroupAvatarGradient } from './groupAvatarGradient'

/**
 * DS4 Group-header block.
 *
 * Mirrors `.group-header` → `.group-stats-row` in
 * `docs/mockups/warme-kueche-group-detail.html`:
 *   1. `.cover`            — rounded warm amber gradient banner.
 *   2. `.group-avatar-wrap`— pulled up 36 px with `z-index: 1` so the
 *                            avatar sits above the cover (this is the
 *                            post-bug stacking fix from the mockup).
 *   3. `.group-heading`    — Cormorant-Garamond h1 + muted description.
 *   4. `.group-stats-row`  — recipe count · members stack · default portions.
 *
 * The avatar uses `getGroupAvatarGradient(id)` so the 3 tints rotate
 * deterministically across the user's groups for visual variety.
 */
export function GroupDetailHeader({
  group,
  recipeCount,
}: {
  group: GroupDetail
  recipeCount: number
}) {
  const initial = group.name.trim().charAt(0).toUpperCase() || '·'
  const swatch = getGroupAvatarGradient(group.id)
  const portionsLabel = group.defaultServings === 1 ? 'Portion' : 'Portionen'
  const recipesLabel = recipeCount === 1 ? 'Rezept' : 'Rezepte'

  // Avatar stack: first three members inline, remainder collapsed into a
  // "+N" chip so a 10-person group doesn't push the row off the page.
  const shown = group.members.slice(0, 3)
  const remaining = Math.max(0, group.memberCount - shown.length)
  const membersLabel = group.memberCount === 1 ? 'Mitglied' : 'Mitglieder'

  return (
    <section className="px-5 pt-2 md:px-8 md:pt-4">
      <div
        data-testid="group-cover"
        aria-hidden="true"
        className={cn(
          'relative h-[120px] rounded-[24px] border border-[#fde68a] md:h-[180px]',
        )}
        style={{
          backgroundImage: [
            'linear-gradient(135deg, rgba(180,83,9,0.15), rgba(217,119,6,0.1) 50%, rgba(252,211,77,0.2))',
            'radial-gradient(circle at 20% 40%, #fde68a 0%, transparent 55%)',
            'radial-gradient(circle at 85% 75%, #fed7aa 0%, transparent 55%)',
          ].join(', '),
          backgroundColor: '#fef3c7',
        }}
      />

      {/* Overlapping avatar — relative + z-10 wins the stacking fight
          against the cover when shadows or sibling overlays get added. */}
      <div className="relative z-10 -mt-[36px] pl-1.5">
        <span
          data-testid="group-avatar-big"
          aria-hidden="true"
          className="grid h-[72px] w-[72px] place-items-center rounded-[20px] border-4 border-background font-serif text-[34px] font-semibold shadow-[0_4px_18px_-4px_rgba(146,64,14,0.3)]"
          style={{ background: swatch.background, color: swatch.color }}
        >
          {initial}
        </span>
      </div>

      <div className="px-1.5 pt-3.5">
        <h1 className="m-0 mb-1 font-serif text-[clamp(24px,5.5vw,32px)] font-semibold leading-[1.1] tracking-[-0.015em]">
          {group.name}
        </h1>
        {group.description && (
          <p className="text-[13px] leading-[1.4] text-[hsl(var(--muted-foreground))]">
            {group.description}
          </p>
        )}
      </div>

      <div className="mt-3.5 flex flex-wrap gap-[14px] px-1 text-[13px] text-[hsl(var(--muted-foreground))]">
        <span className="inline-flex items-center gap-1.5">
          <BookOpen className="h-[14px] w-[14px] text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
          <strong className="font-semibold text-foreground">{recipeCount}</strong>{' '}
          {recipesLabel}
        </span>

        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex" aria-label="Mitglieder">
            {shown.map((m, idx) => (
              <MemberChip
                key={m.userId}
                initial={m.displayName.trim().charAt(0).toUpperCase() || '·'}
                tintIndex={idx}
                isStacked={idx > 0}
              />
            ))}
            {remaining > 0 && (
              <span
                aria-hidden="true"
                className="-ml-2 grid h-[26px] w-[26px] place-items-center rounded-full border-2 border-background bg-[hsl(var(--primary)/0.08)] text-[10px] font-semibold text-primary"
              >
                +{remaining}
              </span>
            )}
          </span>
          <strong className="font-semibold text-foreground">{group.memberCount}</strong>{' '}
          {membersLabel}
        </span>

        <span className="inline-flex items-center gap-1.5">
          <Users className="h-[14px] w-[14px] text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
          Standard{' '}
          <strong className="font-semibold text-foreground">
            {group.defaultServings} {portionsLabel}
          </strong>
        </span>
      </div>
    </section>
  )
}

const MEMBER_CHIP_TINTS = [
  'bg-[linear-gradient(135deg,#fed7aa,#fdba74)] text-[#7c2d12]',
  'bg-[linear-gradient(135deg,#fecaca,#fca5a5)] text-[#7f1d1d]',
  'bg-[linear-gradient(135deg,#d9f99d,#a3e635)] text-[#365314]',
] as const

function MemberChip({
  initial,
  tintIndex,
  isStacked,
}: {
  initial: string
  tintIndex: number
  isStacked: boolean
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid h-[26px] w-[26px] place-items-center rounded-full border-2 border-background text-[11px] font-semibold',
        MEMBER_CHIP_TINTS[tintIndex % MEMBER_CHIP_TINTS.length],
        isStacked && '-ml-2',
      )}
    >
      {initial}
    </span>
  )
}
