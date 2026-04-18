import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * DS1 native-select wrapper.
 *
 * Design choice: we wrap a plain `<select>` instead of pulling in
 * `@radix-ui/react-select`. The downstream slices (DS4 creator filter,
 * DS6 unit picker) only need a single-value dropdown without custom
 * styling of the option list, so a native element keeps the bundle
 * small and avoids accessibility work for a headless Radix popover.
 *
 * Styled to match the DS1 Input: same height, padding, border, amber
 * focus ring, plus an inline chevron background-image so the control
 * is obviously clickable even with `appearance: none` stripping the
 * platform arrow.
 */
export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>

const chevronBg =
  "url(\"data:image/svg+xml;charset=utf-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2357534e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'/%3e%3c/svg%3e\")"

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          'flex h-11 w-full appearance-none rounded-md border border-input bg-background px-3.5 pr-10 py-2.5 text-base text-foreground shadow-sm transition-[border-color,box-shadow,background-color] duration-150',
          'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        style={{
          backgroundImage: chevronBg,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 12px center',
          backgroundSize: '18px 18px',
        }}
        {...props}
      >
        {children}
      </select>
    )
  },
)
Select.displayName = 'Select'

export { Select }
