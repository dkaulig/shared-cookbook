import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import type { VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { buttonVariants } from './button-variants'

/**
 * Canonical shadcn/ui Button (New York style, neutral base color).
 * Mirrors https://ui.shadcn.com/docs/components/button as of shadcn CLI v2.
 * Kept minimal as the S0 "base components placeholder" — real feature
 * components arrive with later slices.
 *
 * The CVA definition lives in `./button-variants` so this file remains
 * component-only (satisfies `react-refresh/only-export-components`).
 */
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { Button }
