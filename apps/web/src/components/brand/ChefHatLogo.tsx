import type { SVGProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * Warme-Küche chef-hat mark (DS2).
 *
 * Inlined from the `<svg>` in `docs/mockups/warme-kueche-login.html` so
 * the visual matches the mockup byte-for-byte. Uses `currentColor` for
 * both stroke and fill slots, which lets us drop it into the amber-tile
 * logo chip where the surrounding `color` controls the silhouette.
 */
export interface ChefHatLogoProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  /** Square icon dimension in CSS pixels. Defaults to 22 (mockup value). */
  size?: number
}

export function ChefHatLogo({ size = 22, className, ...rest }: ChefHatLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn(className)}
      {...rest}
    >
      <path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z" />
      <path d="M6 17h12" />
    </svg>
  )
}
