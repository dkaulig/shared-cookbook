import { expect, test } from '@playwright/test'

/**
 * TABLET-0 — Playwright smoke for the 3-zone responsive shell.
 *
 * Verifies the foundation invariants:
 *  - `< md` (mobile, 400 px): BottomNav visible, SideRail + DesktopTopNav hidden.
 *  - `md:`–`xl:` (tablet, 900 px ≈ iPad portrait): SideRail visible,
 *    BottomNav + DesktopTopNav hidden. Clicking a rail item changes route.
 *  - `≥ xl` (desktop, 1400 px): DesktopTopNav visible, SideRail +
 *    BottomNav hidden. Clicking a DesktopTopNav item changes route +
 *    the active item carries `aria-current="page"` (TABLET-5).
 *
 * NOT wired into CI. Credentials-gated via `PLAYWRIGHT_TEST_EMAIL` /
 * `PLAYWRIGHT_TEST_PASSWORD`; absent env vars → `test.skip(...)` so
 * the spec is safe to lint/compile without a live stack. Manual run:
 *
 *   PLAYWRIGHT_TEST_EMAIL=…
 *   PLAYWRIGHT_TEST_PASSWORD=…
 *   pnpm -C apps/web test:e2e
 */

test('tablet-foundation: SideRail + BottomNav visibility across the 3 zones', async ({
  page,
}) => {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD
  test.skip(
    !email || !password,
    'PLAYWRIGHT_TEST_EMAIL / PLAYWRIGHT_TEST_PASSWORD not set — manual-run only, see docs/ops.md §9',
  )

  // Start at tablet-portrait (900 px) so we exercise the tablet zone
  // before resizing into the other two.
  await page.setViewportSize({ width: 900, height: 1200 })

  // 1. Login — identical flow to cook-now / offline specs.
  await page.goto('/')
  await page.getByLabel(/e-?mail/i).fill(email!)
  await page.getByLabel(/passwort/i).fill(password!)
  await page.getByRole('button', { name: /anmelden/i }).click()
  await page.waitForURL(/\/(?:$|gruppen|rezepte|home)/)

  const sideRail = page.getByRole('navigation', { name: /seitenleiste/i })
  const bottomNav = page.getByRole('navigation', { name: /hauptnavigation/i })
  const desktopNav = page.getByRole('navigation', { name: /desktop-navigation/i })

  // 2. Tablet zone (900 px) — SideRail visible, BottomNav + DesktopTopNav hidden.
  await expect(sideRail).toBeVisible()
  await expect(bottomNav).toBeHidden()
  await expect(desktopNav).toBeHidden()

  // 3. Clicking a rail nav item changes the route.
  await sideRail.getByRole('link', { name: /gruppen/i }).click()
  await expect(page).toHaveURL(/\/groups(?:\/|$)/)

  // 4. Mobile zone (400 px) — SideRail + DesktopTopNav hidden, BottomNav visible.
  await page.setViewportSize({ width: 400, height: 900 })
  await expect(sideRail).toBeHidden()
  await expect(bottomNav).toBeVisible()
  await expect(desktopNav).toBeHidden()

  // 5. Desktop zone (1400 px, TABLET-5) — DesktopTopNav visible,
  //    SideRail + BottomNav hidden. Clicking a DesktopTopNav item
  //    changes the route and the clicked item carries `aria-current="page"`.
  await page.setViewportSize({ width: 1400, height: 1000 })
  await expect(sideRail).toBeHidden()
  await expect(bottomNav).toBeHidden()
  await expect(desktopNav).toBeVisible()
  // Every primary route lives in the desktop bar.
  await expect(desktopNav.getByRole('link', { name: /start/i })).toBeVisible()
  await expect(desktopNav.getByRole('link', { name: /gruppen/i })).toBeVisible()
  await expect(desktopNav.getByRole('link', { name: /wochenplan/i })).toBeVisible()
  await expect(desktopNav.getByRole('link', { name: /profil/i })).toBeVisible()
  // Clicking Wochenplan changes the route + marks the link aria-current.
  await desktopNav.getByRole('link', { name: /wochenplan/i }).click()
  await expect(page).toHaveURL(/\/wochenplan(?:\/|$)/)
  await expect(desktopNav.getByRole('link', { name: /wochenplan/i })).toHaveAttribute(
    'aria-current',
    'page',
  )
})
