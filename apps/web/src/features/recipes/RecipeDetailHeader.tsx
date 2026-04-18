import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  BarChart3,
  Bookmark,
  Camera,
  Clock,
  MoreHorizontal,
  Share2,
  Star,
  User,
} from 'lucide-react'
import type { RecipeDetailDto } from '@familien-kochbuch/shared'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { RecipeForkBanner } from './RecipeForkBanner'
import { recipePhotoGradient } from './recipePhotoGradient'

const DIFFICULTY_LABEL: Record<number, string> = {
  1: 'Einfach',
  2: 'Mittel',
  3: 'Aufwendig',
}

export interface RecipeDetailHeaderProps {
  recipe: RecipeDetailDto
  /** Owning group id — used to wire the back button destination. */
  groupId: string
  /** Aggregate rating average (null when nobody has rated). */
  avgRating: number | null
  /** Aggregate rating count (0 when nobody has rated). */
  ratingCount: number
  /** Name of the source group when this recipe is a fork. */
  sourceGroupName: string | null
  onBack: () => void
  onFork: () => void
  onEdit: () => void
  onDelete: () => void
}

/**
 * DS5 recipe-detail header: floating top bar + hero photo + overlapping
 * title card with tag chips, headline, italic description, stat row and
 * optional fork banner.
 *
 * Scroll-aware top bar: below the threshold it renders translucent round
 * icon buttons over the hero; past the threshold the bar becomes an
 * opaque cream strip with the recipe title + backdrop blur. The
 * threshold is hero-height minus the top-bar height so the transition
 * is driven by the hero actually leaving the viewport rather than a
 * hardcoded pixel value.
 *
 * The overflow menu (Mehr) exposes the fork / edit / delete actions the
 * old RecipeDetailPage had in a header row. The Share + Bookmark buttons
 * are visible-only placeholders for now (wired in a later slice); the
 * aria-label communicates intent.
 */
export function RecipeDetailHeader({
  recipe,
  groupId: _groupId,
  avgRating,
  ratingCount,
  sourceGroupName,
  onBack,
  onFork,
  onEdit,
  onDelete,
}: RecipeDetailHeaderProps) {
  const heroRef = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    function onScroll() {
      const hero = heroRef.current
      if (!hero) return
      const threshold = hero.offsetHeight - 56
      setScrolled(window.scrollY > threshold)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const firstPhoto = recipe.photos[0] ?? null
  const totalPhotos = recipe.photos.length
  const ratingFormatted =
    avgRating != null ? avgRating.toFixed(1).replace('.', ',') : null

  const heroStyle = firstPhoto
    ? undefined
    : {
        backgroundImage: `linear-gradient(180deg, rgba(28,25,23,0) 50%, rgba(28,25,23,0.45) 100%), ${recipePhotoGradient(recipe.id)}`,
      }

  return (
    <>
      {/* ── Top bar (fixed, overlays hero) ─────────────────────── */}
      <div
        data-testid="recipe-topbar"
        className={cn(
          'fixed inset-x-0 top-0 z-[10] flex items-center justify-between px-4 py-3 transition-colors duration-200',
          scrolled
            ? 'border-b border-border bg-background/92 backdrop-blur-lg'
            : 'border-b border-transparent bg-transparent',
        )}
        style={{ paddingTop: 'calc(12px + env(safe-area-inset-top, 0px))' }}
      >
        <IconOverlayButton ariaLabel="Zurück" onClick={onBack} scrolled={scrolled}>
          <ArrowLeft className="h-[18px] w-[18px]" aria-hidden="true" />
        </IconOverlayButton>
        {scrolled && (
          <span className="mx-3 flex-1 truncate text-center font-serif text-[17px] font-semibold text-foreground">
            {recipe.title}
          </span>
        )}
        <div className="flex gap-2">
          <IconOverlayButton ariaLabel="Teilen" scrolled={scrolled}>
            <Share2 className="h-[18px] w-[18px]" aria-hidden="true" />
          </IconOverlayButton>
          <IconOverlayButton ariaLabel="Merken" scrolled={scrolled}>
            <Bookmark className="h-[18px] w-[18px]" aria-hidden="true" />
          </IconOverlayButton>
          <div className="relative">
            <IconOverlayButton
              ariaLabel="Mehr"
              scrolled={scrolled}
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
            </IconOverlayButton>
            {menuOpen && (
              <ul
                role="menu"
                aria-label="Weitere Aktionen"
                className="absolute right-0 top-[calc(100%+6px)] z-50 w-56 overflow-hidden rounded-[12px] border border-border bg-card py-1 shadow-lg"
              >
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false)
                    onFork()
                  }}
                >
                  In andere Gruppe kopieren
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false)
                    onEdit()
                  }}
                >
                  Bearbeiten
                </MenuItem>
                <MenuItem
                  destructive
                  onClick={() => {
                    setMenuOpen(false)
                    onDelete()
                  }}
                >
                  Löschen
                </MenuItem>
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* ── Hero ────────────────────────────────────────────────── */}
      <div
        ref={heroRef}
        data-testid="hero-surface"
        className="relative aspect-[4/3] w-full overflow-hidden bg-[radial-gradient(circle_at_35%_55%,#c3d4ca_0%,#4f7961_45%,#2b4435_85%)] md:aspect-[21/9] md:max-h-[420px]"
        style={heroStyle}
      >
        {firstPhoto && (
          <img
            src={firstPhoto}
            alt={recipe.title}
            className="h-full w-full object-cover"
          />
        )}
        {totalPhotos > 0 && (
          <span className="absolute bottom-4 right-4 inline-flex items-center gap-1.5 rounded-full bg-[rgba(28,25,23,0.6)] px-2.5 py-1 text-[12px] font-medium text-white backdrop-blur">
            <Camera className="h-3 w-3" aria-hidden="true" />
            Foto 1 / {totalPhotos}
          </span>
        )}
      </div>

      {/* ── Overlapping title card ──────────────────────────────── */}
      <div className="mx-auto max-w-3xl px-5 md:max-w-[920px] md:px-8">
        <div className="relative z-[2] -mt-10 rounded-[24px] border border-border bg-card px-5 py-5 shadow-[0_8px_24px_-8px_rgba(79,121,97,0.18),0_2px_6px_-2px_rgba(28,25,23,0.04)]">
          {recipe.tags.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {recipe.tags.map((tag) => (
                <Badge key={tag.id} variant="mini">
                  {tag.name}
                </Badge>
              ))}
            </div>
          )}

          <h1 className="mb-2 font-serif text-[clamp(28px,6.5vw,38px)] font-semibold leading-[1.1] tracking-[-0.015em] text-foreground">
            {recipe.title}
          </h1>

          {recipe.description && (
            <p className="mb-3.5 font-serif-body text-[15px] italic leading-[1.5] text-[hsl(var(--muted-foreground))]">
              {recipe.description}
            </p>
          )}

          <div className="flex flex-wrap gap-4 border-t border-dashed border-border pt-3 text-[13px] text-[hsl(var(--muted-foreground))]">
            {ratingFormatted && (
              <span className="inline-flex items-center gap-1 font-bold text-[hsl(var(--star,var(--primary)))]">
                <Star
                  className="h-[15px] w-[15px] fill-current"
                  aria-hidden="true"
                />
                {ratingFormatted}{' '}
                <span className="font-medium text-[hsl(var(--muted-foreground))]">
                  ({ratingCount})
                </span>
              </span>
            )}
            {recipe.prepTimeMinutes != null && (
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-[15px] w-[15px]" aria-hidden="true" />
                <strong className="font-semibold text-foreground">
                  {recipe.prepTimeMinutes} Min
                </strong>
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <BarChart3 className="h-[15px] w-[15px]" aria-hidden="true" />
              {DIFFICULTY_LABEL[recipe.difficulty] ?? 'Mittel'}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <User className="h-[15px] w-[15px]" aria-hidden="true" />
              {recipe.createdByDisplayName}
            </span>
          </div>

          {recipe.forkOfRecipeId && (
            // The detail DTO doesn't carry the original's title — forks
            // start with an identical title on creation, so using the
            // current recipe's title is a close-enough stand-in. A
            // follow-up slice could fetch the original (if the current
            // user has access) for an authoritative label.
            <RecipeForkBanner
              className="mt-3.5"
              originalRecipeId={recipe.forkOfRecipeId}
              originalRecipeTitle={recipe.title}
              sourceGroupName={sourceGroupName}
            />
          )}
        </div>
      </div>
    </>
  )
}

interface IconOverlayButtonProps {
  ariaLabel: string
  onClick?: () => void
  children: React.ReactNode
  scrolled: boolean
  'aria-expanded'?: boolean
  'aria-haspopup'?: 'menu' | 'true'
}

function IconOverlayButton({
  ariaLabel,
  onClick,
  children,
  scrolled,
  'aria-expanded': ariaExpanded,
  'aria-haspopup': ariaHaspopup,
}: IconOverlayButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHaspopup}
      onClick={onClick}
      className={cn(
        'grid h-10 w-10 place-items-center rounded-full border transition-all active:scale-95',
        scrolled
          ? 'border-border bg-background text-foreground hover:bg-[hsl(var(--secondary))]'
          : 'border-white/10 bg-[rgba(28,25,23,0.55)] text-white backdrop-blur hover:bg-[rgba(28,25,23,0.8)]',
      )}
    >
      {children}
    </button>
  )
}

function MenuItem({
  onClick,
  destructive,
  children,
}: {
  onClick: () => void
  destructive?: boolean
  children: React.ReactNode
}) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        onClick={onClick}
        className={cn(
          'w-full px-4 py-2.5 text-left text-[14px] transition-colors hover:bg-[hsl(var(--muted))]',
          destructive ? 'text-[hsl(var(--destructive))]' : 'text-foreground',
        )}
      >
        {children}
      </button>
    </li>
  )
}
