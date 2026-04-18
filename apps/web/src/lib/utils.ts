import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Conditional class-name helper used across shadcn/ui primitives.
 * Combines `clsx` (for truthy/falsy + object conditionals) with
 * `tailwind-merge` (resolves conflicting Tailwind utilities, last wins).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
