import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { GroupSummary, RecipeSummaryDto } from '@shared-cookbook/shared'
import {
  Camera,
  Check,
  Clock,
  Leaf,
  MessageSquare,
  Plus,
  Shuffle,
  Soup,
  Sparkles,
  Star,
  Video,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/useAuth'
import { FeatureGate } from '@/features/_shared/FeatureGate'
import { useFeatures } from '@/features/_shared/useFeatures'
import { CreateGroupDialog } from '@/features/groups/CreateGroupDialog'
import { GroupPickerDialog } from '@/features/groups/GroupPickerDialog'
import { ReceivedInvitesBanner } from '@/features/groups/ReceivedInvitesBanner'
import { useMyGroups } from '@/features/groups/useMyGroups'
import { useRecentlyCooked } from '@/features/recipes/useRecentlyCooked'
import { recipePhotoGradient } from '@/features/recipes/recipePhotoGradient'
import { formatRelativeDe } from '@/features/recipes/relativeTime'
import { localeTimeGreeting } from '@/lib/greeting'
import { seasonalEveningLabel } from '@/lib/seasonalLabel'
import { cn } from '@/lib/utils'

/**
 * DS3 Home / Dashboard — the post-login landing page.
 *
 * Mirrors `docs/mockups/variant-a-home.html` section-for-section:
 *   1. Greeting hero (time-of-day kicker + display headline + tagline).
 *   2. Horizontal quick-filter chip row (6 chips, sage-filled primary + outlines).
 *   3. Pending-invite banner — reuses the DS3-restyled ReceivedInvitesBanner.
 *   4. "Meine Gruppen" — group cards + "+ Neue Gruppe" dashed card.
 *   5. "Zuletzt gekocht" — recipe cards w/ gradient fallback photo, rating pill, tags.
 *
 * Data sources: `useAuth()`, `useMyGroups()`, `useMyReceivedInvites()` (via
 * the banner), and `useRecentlyCooked(biggestGroupId)`.
 */
export function HomePage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const groups = useMyGroups()
  // REL-7 — the three KI-Import links under the hero chips (Video / Foto
  // / Chat) depend on AI being available. When the operator booted
  // without AI we hide them; the URL-import link stays visible only
  // when `urlImport` is true (AI path) or when JSON-LD extraction is
  // available (REL-8 — currently always-on as a hook for the parallel
  // lane to fill in).
  const features = useFeatures()
  const anyAiLinkVisible =
    features.ai.features.urlImport ||
    features.ai.features.photoImport ||
    features.ai.features.chat
  const [showCreate, setShowCreate] = useState(false)
  // BF1 #6 — when the chip-press fires for a multi-group user we open
  // the group-picker instead of teleporting them into "the biggest
  // group". Holding the active preset alongside the picker state lets
  // the picker callback navigate with the right query string.
  const [pickerPreset, setPickerPreset] = useState<string | null>(null)

  const biggestGroup = useMemo<GroupSummary | undefined>(() => {
    if (!groups.data || groups.data.length === 0) return undefined
    // Prefer collaborative groups over the Private Sammlung so the
    // "Zuletzt gekocht" section feels alive for the common case.
    const collaborative = groups.data.filter((g) => !g.isPrivateCollection)
    const pool = collaborative.length > 0 ? collaborative : groups.data
    return [...pool].sort((a, b) => b.memberCount - a.memberCount)[0]
  }, [groups.data])

  const recent = useRecentlyCooked(biggestGroup?.id)

  const greeting = localeTimeGreeting()
  const season = seasonalEveningLabel()
  const displayName = user?.displayName ?? ''

  const groupIndexById = useMemo(() => {
    const map = new Map<string, number>()
    groups.data?.forEach((g, i) => map.set(g.id, i))
    return map
  }, [groups.data])

  function navigateWithPreset(groupId: string, filterPreset: string | null) {
    const qs = filterPreset ? `?preset=${encodeURIComponent(filterPreset)}` : ''
    navigate(`/groups/${groupId}${qs}`)
  }

  function handlePresetChip(filterPreset: string | null) {
    const list = groups.data ?? []
    if (list.length === 0) {
      // No groups yet → the user needs to create one before filtering.
      setShowCreate(true)
      return
    }
    const only = list[0]
    if (list.length === 1 && only) {
      // Single group → deterministic direct navigation, no surprise jump.
      navigateWithPreset(only.id, filterPreset)
      return
    }
    // Multiple groups → ask the user which one to filter.
    setPickerPreset(filterPreset)
  }

  return (
    <div className="mx-auto w-full max-w-[720px] px-5 md:max-w-[1120px] md:px-8">
      {/* ───────── Greeting hero ───────── */}
      <section className="pb-5 pt-7">
        <p className="text-[13px] font-medium tracking-[0.01em] text-muted-foreground">
          {greeting},{' '}
          <span className="font-semibold text-foreground">{displayName || 'willkommen'}</span>
        </p>
        <h1 className="mt-1 font-serif text-[clamp(30px,7vw,40px)] font-semibold leading-[1.05] tracking-[-0.015em]">
          Was kochen wir heute?
        </h1>
        <p className="mt-1 font-serif-body text-[15px] italic leading-[1.5] text-[hsl(var(--muted-foreground))]">
          Ein schneller Tipp, was Hunger beruhigt.
        </p>

        {/* Chip row — horizontal scroll, primary first. */}
        <div className="-mx-5 mt-3 flex gap-2 overflow-x-auto scroll-smooth px-5 pb-2 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Chip
            primary
            icon={<Clock className="h-3.5 w-3.5" />}
            onClick={() => handlePresetChip('quick')}
          >
            Schnell (&lt; 30 Min)
          </Chip>
          <Chip icon={<Soup className="h-3.5 w-3.5" />} onClick={() => handlePresetChip('warm')}>
            Warm
          </Chip>
          <Chip icon={<Leaf className="h-3.5 w-3.5" />} onClick={() => handlePresetChip('veggie')}>
            Vegetarisch
          </Chip>
          <Chip icon={<Shuffle className="h-3.5 w-3.5" />} onClick={() => handlePresetChip('random')}>
            Zufall
          </Chip>
          <Chip onClick={() => handlePresetChip('season')}>{season}</Chip>
          <Chip onClick={() => handlePresetChip('easy')}>Wenig Aufwand</Chip>
        </div>

        {/*
          P2-7 + P2-8 — two discreet KI-Import entry points sitting
          under the hero chips: the "what do I do next?" zone on Home.
          Rendered as text links with a sparkle + medium-specific icon
          (Video for URL, Camera for Foto) so they stay secondary to
          the primary navigation without burying themselves in a drawer.
          The dashed-border + sage-text treatment is kept identical
          between the two so they read as siblings — deliberately equal
          weight, since video and photo are two legitimate starting
          points for the AI flow.
        */}
        {/*
          REL-7 — KI-Import-CTA row. The whole wrapper collapses when AI
          is off (no wasted vertical space); individual links hide
          independently so partial-provider configurations still render
          the surviving CTAs.
        */}
        {anyAiLinkVisible && (
          <div className="mt-3 flex flex-wrap gap-2" data-testid="home-ai-imports">
            <FeatureGate feature="videoImport">
              <Link
                to="/rezepte/import/url"
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[hsl(var(--input))] bg-card/60 px-3 py-1.5 text-[13px] font-semibold text-primary transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.08)]"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                <Video className="h-3.5 w-3.5" aria-hidden="true" />
                Rezept aus Video importieren
              </Link>
            </FeatureGate>
            <FeatureGate feature="photoImport">
              <Link
                to="/rezepte/import/photos"
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[hsl(var(--input))] bg-card/60 px-3 py-1.5 text-[13px] font-semibold text-primary transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.08)]"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                Rezept aus Foto importieren
              </Link>
            </FeatureGate>
            {/*
              P2-9 — third KI-import entry: conversational recipe creation.
              Rendered as a sibling of the Video + Foto links; MessageSquare
              icon picks out the conversational medium. "Erfinden" instead
              of "Importieren" because the chat path creates something new
              rather than pulling an existing recipe from a source.
            */}
            <FeatureGate feature="chat">
              <Link
                to="/chat"
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[hsl(var(--input))] bg-card/60 px-3 py-1.5 text-[13px] font-semibold text-primary transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.08)]"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                Rezept im Chat erfinden
              </Link>
            </FeatureGate>
          </div>
        )}
      </section>

      {/* ───────── Pending-invite banner ───────── */}
      <div className="mt-2">
        <ReceivedInvitesBanner />
      </div>

      {/* ───────── Meine Gruppen ───────── */}
      <section className="mt-7">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-serif text-2xl font-semibold tracking-[-0.005em]">Meine Gruppen</h2>
          <Link
            to="/groups"
            className="text-[13px] font-semibold text-primary hover:underline"
          >
            Alle ansehen →
          </Link>
        </div>

        {groups.isLoading && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {[0, 1].map((i) => (
              <div
                key={i}
                role="status"
                className="h-[110px] animate-pulse rounded-[18px] bg-muted"
              />
            ))}
          </div>
        )}

        {groups.isError && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
            Gruppen konnten nicht geladen werden.
          </p>
        )}

        {groups.isSuccess && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {groups.data.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                tintIndex={(groupIndexById.get(group.id) ?? 0) % 3}
              />
            ))}
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="flex min-h-[88px] items-center justify-center gap-1.5 rounded-[18px] border-2 border-dashed border-[hsl(var(--input))] text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary"
            >
              <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
              Neue Gruppe anlegen
            </button>
          </div>
        )}
      </section>

      {/* ───────── Zuletzt gekocht ───────── */}
      <section className="mt-7">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-serif text-2xl font-semibold tracking-[-0.005em]">
            Zuletzt gekocht
          </h2>
          {biggestGroup && (
            <Link
              to={`/groups/${biggestGroup.id}`}
              className="text-[13px] font-semibold text-primary hover:underline"
            >
              Alle Rezepte →
            </Link>
          )}
        </div>

        {recent.isSuccess && recent.data.items.length === 0 && (
          <EmptyRecent onCreateGroup={() => setShowCreate(true)} hasGroups={!!biggestGroup} />
        )}

        {recent.isSuccess && recent.data.items.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recent.data.items.map((recipe) => (
              <RecipeCard
                key={recipe.id}
                recipe={recipe}
                groupName={groups.data?.find((g) => g.id === recipe.groupId)?.name ?? ''}
              />
            ))}
          </div>
        )}

        {!biggestGroup && groups.isSuccess && (
          <EmptyRecent onCreateGroup={() => setShowCreate(true)} hasGroups={false} />
        )}
      </section>

      {showCreate && <CreateGroupDialog onClose={() => setShowCreate(false)} />}

      {pickerPreset !== null && groups.data && groups.data.length > 1 && (
        <GroupPickerDialog
          groups={groups.data}
          onPick={(group) => {
            const preset = pickerPreset
            setPickerPreset(null)
            navigateWithPreset(group.id, preset)
          }}
          onClose={() => setPickerPreset(null)}
        />
      )}
    </div>
  )
}

// ── Internal components ──────────────────────────────────────────────

function Chip({
  children,
  icon,
  primary,
  onClick,
}: {
  children: ReactNode
  icon?: ReactNode
  primary?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium shadow-[0_1px_2px_rgba(28,25,23,0.04)] transition-colors',
        primary
          ? 'border border-primary bg-primary text-primary-foreground shadow-[0_2px_8px_-2px_rgba(79,121,97,0.35)] hover:bg-[hsl(var(--primary-hover))]'
          : 'border border-border bg-card text-foreground hover:border-primary',
      )}
    >
      {icon}
      {children}
    </button>
  )
}

const TINTS = [
  // Sage Modern tints mirrored from `.group-avatar.tint-{1,2,3}` in
  // docs/mockups/variant-a-home.html — sage, coral, olive.
  'bg-[#c3d4ca] text-[#2b4435]',
  'bg-[#f0c9b6] text-[#7a3f21]',
  'bg-[#d9e0b5] text-[#4f5b1f]',
] as const

function GroupCard({ group, tintIndex }: { group: GroupSummary; tintIndex: number }) {
  const initial = group.name.trim().charAt(0).toUpperCase() || '·'
  const memberLabel = `${group.memberCount} ${group.memberCount === 1 ? 'Mitglied' : 'Mitglieder'}`

  return (
    <Link
      to={`/groups/${group.id}`}
      aria-label={group.name}
      className="group flex flex-col gap-2 rounded-[18px] border border-border bg-card p-[18px_18px_16px] shadow-[0_1px_2px_rgba(28,25,23,0.04)] transition hover:-translate-y-px hover:border-[hsl(var(--input))] hover:shadow-[0_8px_24px_-8px_rgba(79,121,97,0.18),0_2px_6px_-2px_rgba(28,25,23,0.04)]"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className={cn(
            'grid h-11 w-11 place-items-center rounded-[12px] font-serif text-[20px] font-semibold',
            TINTS[tintIndex % TINTS.length],
          )}
        >
          {initial}
        </span>
        <div className="min-w-0">
          <div className="font-serif text-[20px] font-semibold leading-tight tracking-[-0.005em]">
            {group.name}
          </div>
          <div className="flex flex-wrap gap-1.5 text-[13px] text-muted-foreground">
            <span>
              {group.memberCount === 1 && group.isPrivateCollection
                ? 'nur du'
                : memberLabel}
            </span>
            <span aria-hidden="true" className="text-[hsl(var(--input))]">·</span>
            <span>
              {group.defaultServings} {group.defaultServings === 1 ? 'Portion' : 'Portionen'}
            </span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {group.myRole === 'Admin' ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-[hsl(142_71%_25%/0.08)] px-2 py-0.5 text-[11px] font-medium tracking-[0.02em] text-[hsl(142_71%_36%)]">
            <Check className="h-[10px] w-[10px]" aria-hidden="true" />
            Admin
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-md bg-[hsl(var(--primary)/0.08)] px-2 py-0.5 text-[11px] font-medium tracking-[0.02em] text-primary">
            Mitglied
          </span>
        )}
        {group.isPrivateCollection && (
          <span className="inline-flex items-center gap-1 rounded-md bg-[hsl(var(--primary)/0.08)] px-2 py-0.5 text-[11px] font-medium tracking-[0.02em] text-primary">
            Privat
          </span>
        )}
      </div>
    </Link>
  )
}

function RecipeCard({
  recipe,
  groupName,
}: {
  recipe: RecipeSummaryDto
  groupName: string
}) {
  const rating = recipe.avgRating != null ? recipe.avgRating.toFixed(1) : null
  const gradient = recipePhotoGradient(recipe.id)
  const updated = recipe.updatedAt ? formatRelativeDe(new Date(recipe.updatedAt)) : null

  return (
    <Link
      to={`/groups/${recipe.groupId}/recipes/${recipe.id}`}
      aria-label={recipe.title}
      className="group overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_1px_2px_rgba(28,25,23,0.04)] transition hover:-translate-y-px hover:border-[hsl(var(--input))] hover:shadow-[0_8px_24px_-8px_rgba(79,121,97,0.18),0_2px_6px_-2px_rgba(28,25,23,0.04)]"
    >
      <div
        aria-hidden="true"
        className="relative aspect-[16/10] bg-cover bg-center"
        style={{
          backgroundImage: recipe.photo
            ? `url(${recipe.photo})`
            : gradient,
        }}
      >
        {rating && (
          <span className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-[rgba(26,26,24,0.82)] px-2 py-1 text-xs font-semibold text-[#fafafa] backdrop-blur">
            <Star className="h-3 w-3 fill-current" aria-hidden="true" />
            {rating}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5 px-3.5 pb-3.5 pt-3">
        <div className="font-serif text-[19px] font-semibold leading-[1.15] tracking-[-0.005em]">
          {recipe.title}
        </div>
        <div className="flex flex-wrap gap-1.5 text-[12.5px] text-muted-foreground">
          {groupName && <span>{groupName}</span>}
          {groupName && updated && <span aria-hidden="true" className="text-[hsl(var(--input))]">·</span>}
          {updated && <span>{updated}</span>}
        </div>
      </div>
    </Link>
  )
}

function EmptyRecent({
  onCreateGroup,
  hasGroups,
}: {
  onCreateGroup: () => void
  hasGroups: boolean
}) {
  return (
    <div className="rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 p-8 text-center">
      <p className="font-serif text-xl text-foreground">Noch nichts gekocht.</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {hasGroups
          ? 'Probier ein Rezept aus deiner Sammlung.'
          : 'Leg eine Gruppe an und lade Rezepte hoch.'}
      </p>
      <div className="mt-4">
        {hasGroups ? (
          <Button asChild variant="outline">
            <Link to="/groups">Zu meinen Gruppen</Link>
          </Button>
        ) : (
          <Button type="button" onClick={onCreateGroup}>
            Neue Gruppe anlegen
          </Button>
        )}
      </div>
    </div>
  )
}
