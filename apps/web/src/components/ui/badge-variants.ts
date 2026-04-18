import { cva } from 'class-variance-authority'

/**
 * CVA variants for the Warme-Küche Badge.
 *
 * Split out of `badge.tsx` to satisfy `react-refresh/only-export-components`
 * (same pattern the Button uses).
 *
 * - `default`     — secondary / amber-100 chip (the common category chip)
 * - `mini`        — the `.mini-tag` from the mockup, 11 px, dense padding
 * - `destructive` — red-600 surface, cream text
 * - `outline`     — border + foreground text, muted ghost chip
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border border-transparent px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        mini:
          'bg-secondary text-secondary-foreground rounded px-1.5 py-0.5 text-[11px] font-medium',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline:
          'border-border text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)
