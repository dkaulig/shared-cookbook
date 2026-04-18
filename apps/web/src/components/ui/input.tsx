import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * shadcn/ui Input tuned for the Warme-Küche form style.
 *
 * Matches the login-card input in `docs/mockups/warme-kueche-login.html`:
 *   - h-11 (~44 px) touch-friendly height, px-3.5 horizontal padding
 *   - 16 px body font (`text-base`) — prevents iOS zoom on focus
 *   - border-input (stone-300) with bg-background (cream) surface
 *   - focus state: 4 px amber ring at 25 % alpha + amber border
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-11 w-full rounded-md border border-input bg-background px-3.5 py-2.5 text-base text-foreground shadow-sm transition-[border-color,box-shadow,background-color] duration-150',
          'placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
          className,
        )}
        ref={ref}
        {...props}
      />
    )
  },
)
Input.displayName = 'Input'

export { Input }
