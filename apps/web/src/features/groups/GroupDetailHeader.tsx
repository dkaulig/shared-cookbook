import { useState } from 'react'
import { BookOpen, Pencil, Users } from 'lucide-react'
import type { GroupDetail } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { EditGroupDialog } from './EditGroupDialog'
import { getGroupAvatarGradient } from './groupAvatarGradient'

/**
 * DS4 Group-header block (retinted for DS8 Sage Modern).
 *
 * Mirrors `.group-header` → `.group-stats-row` in the group-detail
 * mockup structure, with Sage Modern tokens from `variant-a-*`:
 *   1. `.cover`            — rounded sage gradient banner.
 *   2. `.group-avatar-wrap`— pulled up 36 px with `z-index: 1` so the
 *                            avatar sits above the cover.
 *   3. `.group-heading`    — display h1 + muted description.
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
  const isAdmin = group.myRole === 'Admin'
  const [showEditDialog, setShowEditDialog] = useState(false)

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
          'relative h-[120px] rounded-[24px] border border-[#c3d4ca] md:h-[180px]',
        )}
        style={{
          backgroundImage: [
            'linear-gradient(135deg, rgba(79,121,97,0.18), rgba(141,174,160,0.12) 50%, rgba(195,212,202,0.24))',
            'radial-gradient(circle at 20% 40%, #c3d4ca 0%, transparent 55%)',
            'radial-gradient(circle at 85% 75%, #f0c9b6 0%, transparent 55%)',
          ].join(', '),
          backgroundColor: '#e6ede8',
        }}
      />

      {/* Overlapping avatar — relative + z-10 wins the stacking fight
          against the cover when shadows or sibling overlays get added. */}
      <div className="relative z-10 -mt-[36px] pl-1.5">
        <span
          data-testid="group-avatar-big"
          aria-hidden="true"
          className="grid h-[72px] w-[72px] place-items-center rounded-[20px] border-4 border-background font-serif text-[34px] font-semibold shadow-[0_4px_18px_-4px_rgba(79,121,97,0.3)]"
          style={{ background: swatch.background, color: swatch.color }}
        >
          {initial}
        </span>
      </div>

      <div className="px-1.5 pt-3.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 className="m-0 mb-1 font-serif text-[clamp(24px,5.5vw,32px)] font-semibold leading-[1.1] tracking-[-0.015em]">
            {group.name}
          </h1>
          {isAdmin && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowEditDialog(true)}
            >
              <Pencil className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Gruppe bearbeiten
            </Button>
          )}
        </div>
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

      {showEditDialog && (
        <EditGroupDialog
          groupId={group.id}
          initialName={group.name}
          initialDescription={group.description ?? ''}
          initialDefaultServings={group.defaultServings}
          initialCoverImageUrl={group.coverImageUrl ?? ''}
          onClose={() => setShowEditDialog(false)}
        />
      )}
    </section>
  )
}

const MEMBER_CHIP_TINTS = [
  // Sage Modern member-chip tints — sage / coral / olive, mirroring the
  // `.group-avatar.tint-{1,2,3}` rules in docs/mockups/variant-a-home.html.
  'bg-[linear-gradient(135deg,#c3d4ca,#8daea0)] text-[#2b4435]',
  'bg-[linear-gradient(135deg,#f0c9b6,#d9a281)] text-[#7a3f21]',
  'bg-[linear-gradient(135deg,#d9e0b5,#b6c27e)] text-[#4f5b1f]',
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
