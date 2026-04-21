# Web responsive breakpoints

**Owner:** `apps/web` shell. Lives here (not in `apps/web/README.md`) because
the docs-per-concern pattern in this repo keeps short architectural notes
under `docs/` next to `ops.md`, `bugs-backlog.md`, etc.

**Status:** TABLET-0 (2026-04-21) — foundation slice landed. Full design
rationale: [`docs/plans/2026-04-21-tablet-layout-draft.md`](./plans/2026-04-21-tablet-layout-draft.md).

## The 3-zone model

Tailwind defaults (`sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536)
are the raw atoms. For layout-chrome decisions (nav placement, split-views,
hover policy) we reason in **three** zones:

| Zone    | Viewport range   | Primary nav       | Content pattern          | Hover policy |
| ------- | ---------------- | ----------------- | ------------------------ | ------------ |
| Mobile  | `< md` (<768 px) | `<BottomNav />`   | single-column scroll     | off (touch)  |
| Tablet  | `md:`–`xl:` (768–1279 px) | `<SideRail />` (72 px) | split-views where present | `@media (hover: hover)` gated |
| Desktop | `≥ xl` (≥1280 px) | future TopNav (out of TABLET-0 scope) | max-w constrained | hover-optimised |

The Mobile/Desktop binary that predated TABLET-0 ("everything on `md:`
is desktop") was too coarse — it left the 768–1279 range with no nav
at all once `md:hidden` silently dropped the BottomNav. TABLET-0
installs the Tablet zone as a first-class citizen.

## CSS tokens

Declared in `apps/web/src/index.css` inside `:root`, co-located with
`--bottom-nav-height` and `--topnav-height`:

- `--side-rail-width: 72px` — width reserved by `<SideRail />` in
  the Tablet zone. The rail is a flex-sibling of `<main>` gated by
  `hidden md:flex xl:hidden`, so `<main>` automatically reclaims the
  gutter on Mobile and Desktop.
- `--split-left-width: 340px` — default width of the list column in
  the upcoming split-view primitive (TABLET-1+, not yet consumed).

## Zone → Tailwind helper

Common gates you'll reach for:

- Show **only** in the Tablet zone: `hidden md:flex xl:hidden`
- Hide in the Tablet zone: `md:hidden xl:flex` (or scope explicit).
- Tablet-or-above (current codebase's `md:` default): `md:…` — this
  stays valid, the 3-zone model is additive.

## Hover affordances (touch safety)

Hover styles that shift colour (button fills, card surfaces, nav links)
must be gated behind `@media (hover: hover)` so touch-only tablets
don't leave a tapped element stuck in the hover colour until the next
tap. Tailwind 4 supports arbitrary media queries via the
`[@media(hover:hover)]:` variant prefix. Example from
`apps/web/src/components/ui/button-variants.ts`:

```ts
default: 'bg-primary … [@media(hover:hover)]:hover:bg-[hsl(var(--primary-hover))] …'
```

Pure decorative hovers (link underlines, icon nudges) can stay ungated
— the failure mode is cosmetic, not interactive.

## Non-goals

- TABLET-0 is the foundation only. Split-views for GroupDetail /
  MealPlan / Shopping / Chat, Recipe-Detail two-column, Cook-Mode
  landscape, and Desktop TopNav are separate TABLET-1+ slices.
- The Mobile-zone layout is NOT touched. Changes there belong to a
  Mobile-specific slice (or a bugfix referencing a specific BUG-###).
