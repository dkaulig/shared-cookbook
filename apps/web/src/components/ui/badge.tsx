import * as React from 'react'
import type { VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { badgeVariants } from './badge-variants'

/**
 * shadcn/ui Badge. Renders as a `<span>` so it can nest inside buttons
 * without breaking the "only interactive roles inside interactives"
 * accessibility contract. The CVA definition lives in
 * `./badge-variants` to keep this file component-only.
 */
export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  ),
)
Badge.displayName = 'Badge'

export { Badge, badgeVariants }
