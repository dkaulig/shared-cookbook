import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * shadcn/ui Label (New York style). Minimal version — no Radix-based
 * peer-disable styling yet. We can swap in the full @radix-ui/react-label
 * variant when form primitives land.
 */
export type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>

const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    />
  ),
)
Label.displayName = 'Label'

export { Label }
