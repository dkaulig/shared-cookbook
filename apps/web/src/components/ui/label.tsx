import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * shadcn/ui Label tuned to the Warme-Küche form style.
 *
 * The mockup's `<label>` rule in `warme-kueche-login.html` is
 * `font-size: 13px; font-weight: 600; letter-spacing: 0.01em;`. We
 * keep the shadcn peer-disabled fallback so `<Input disabled>` paired
 * with `<Label>` still dims as users expect.
 */
export type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>

const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        'text-[13px] font-semibold leading-none tracking-[0.01em] text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    />
  ),
)
Label.displayName = 'Label'

export { Label }
