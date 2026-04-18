import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * shadcn/ui Textarea tuned for the Sage Modern form style.
 *
 * Visually mirrors `<Input>` — same tokens, padding, focus ring — but
 * opts into vertical resizing + a min-height that matches the 3-step
 * rows in the recipe-form mockup.
 */
export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          'flex min-h-[96px] w-full rounded-md border border-input bg-background px-3.5 py-2.5 text-base text-foreground shadow-sm transition-[border-color,box-shadow,background-color] duration-150 resize-y',
          'placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    )
  },
)
Textarea.displayName = 'Textarea'

export { Textarea }
