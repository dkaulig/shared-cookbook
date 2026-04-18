import { cva } from 'class-variance-authority'

/**
 * CVA variants for the Warme-Küche Button (DS1).
 *
 * The default variant is tuned to match `button.primary` in
 * `docs/mockups/warme-kueche-login.html`:
 *   - amber-700 surface (via the --primary token)
 *   - cream text (--primary-foreground)
 *   - soft amber glow shadow
 *   - amber-800 on hover (via --primary-hover)
 *   - 99% scale tap motion
 *
 * The file is kept component-free so `react-refresh/only-export-components`
 * stays happy in `button.tsx`.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(120,53,15,0.1),0_4px_12px_-4px_rgba(180,83,9,0.4)] hover:bg-[var(--primary-hover)] active:scale-[0.99]',
        destructive:
          'bg-destructive text-destructive-foreground shadow-[0_1px_2px_rgba(120,53,15,0.1),0_4px_12px_-4px_rgba(220,38,38,0.35)] hover:bg-destructive/90 active:scale-[0.99]',
        outline:
          'border border-input bg-background text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary:
          'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost:
          'text-foreground hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-5 py-2 text-sm',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-11 rounded-md px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)
