# DS8 — Sage Modern Redesign

**Slice:** DS8 (post Phase-1.5 follow-up)
**Status:** planned
**Owner:** orchestrator dispatches general-purpose impl agent, then feature-dev:code-reviewer
**Date:** 2026-04-18

## Why

User rejected the shipped "Warme Küche" palette + Cormorant/Libre Baskerville serif typography after live-testing the app. They picked **Variant A · Sage Modern** from the three mockups under `docs/mockups/variant-{a-sage,b-crisp,c-editorial}.html` and explicitly asked for **Option C**: color swap + drop all serif typography in favour of Inter-only.

The layout, component structure, route tree, and interaction model **do not change**. This is a token-level redesign.

## Scope (what changes)

### 1. Color tokens — `apps/web/src/index.css`

Swap the light-mode `:root` block HSL triplets. Hex source: `docs/mockups/variant-a-sage.html` + `variant-a-home.html`.

| Token | Old (Warme Küche amber) | New (Sage Modern) | Hex |
|-------|-------------------------|--------------------|-----|
| `--background` | `48 100% 96%` | `60 10% 97%` | `#f7f7f6` |
| `--foreground` | `20 14% 10%` | `60 4% 10%` | `#1a1a18` |
| `--card` | `0 0% 100%` | `0 0% 100%` | `#ffffff` (unchanged) |
| `--card-foreground` | `20 14% 10%` | `60 4% 10%` | `#1a1a18` |
| `--popover` | `0 0% 100%` | `0 0% 100%` | unchanged |
| `--popover-foreground` | `20 14% 10%` | `60 4% 10%` | `#1a1a18` |
| `--primary` | `32 95% 37%` (amber-700) | `148 21% 40%` | `#4f7961` sage |
| `--primary-foreground` | `48 100% 96%` | `0 0% 100%` | `#ffffff` |
| `--primary-hover` | `25 75% 31%` | `148 24% 32%` | `#3e6450` |
| `--secondary` | `48 96% 89%` | `148 18% 85%` | `#c3d4ca` sage-tint |
| `--secondary-foreground` | `25 75% 31%` | `148 24% 22%` | `#2b4435` |
| `--muted` | `60 5% 96%` | `48 4% 94%` | `#efefeb` |
| `--muted-foreground` | `25 5% 35%` | `48 6% 33%` | `#57574f` |
| `--accent` | `48 96% 89%` | `16 59% 60%` | `#d97757` coral |
| `--accent-foreground` | `25 75% 31%` | `0 0% 100%` | `#ffffff` |
| `--destructive` | `0 72% 51%` | unchanged | `#dc2626` |
| `--destructive-foreground` | `48 100% 96%` | `0 0% 100%` | `#ffffff` |
| `--border` | `24 6% 90%` | `50 7% 89%` | `#e4e4e0` |
| `--input` | `24 6% 84%` | `50 6% 78%` | `#c8c8c2` |
| `--ring` | `32 95% 37%` | `148 21% 40%` | `#4f7961` sage |

**Dark mode** (`.dark` block): keep dark mode usable but lean on the new accents. Updated triplets:
- `--primary: 148 26% 55%` (#6fa486 sage-light)
- `--primary-hover: 148 23% 48%`
- `--accent: 16 70% 68%` (coral-light)
- Rest stays dark stone-style (existing values OK, just update amber references to sage).

### 2. Font tokens — `apps/web/src/index.css` (theme block) + `apps/web/src/styles/fonts.ts`

Central lever — one edit in `@theme inline` cascades to all 67 `font-serif` usages:

```css
--font-sans: "Inter", system-ui, sans-serif;
--font-serif: "Inter", system-ui, sans-serif;       /* was: Cormorant Garamond */
--font-serif-body: "Inter", system-ui, sans-serif;  /* was: Libre Baskerville */
```

Then in `styles/fonts.ts` **remove** Cormorant + Libre Baskerville imports (they'd still bundle otherwise). Keep the four Inter weights.

### 3. Recipe photo gradients — `apps/web/src/features/recipes/recipePhotoGradient.ts`

Replace the 4 amber/red/lime/wheat gradients with the sage/coral/oliv/earth set from `variant-a-home.html` (`.recipe-photo-{1..4}`):

```ts
// recipe-photo-1 — sage / deep-green
'linear-gradient(135deg, #a8c0b0 0%, #4f7961 100%)',
// recipe-photo-2 — coral / burnt-terracotta
'linear-gradient(135deg, #e9b99c 0%, #c26b43 100%)',
// recipe-photo-3 — olive / herbal-green
'linear-gradient(135deg, #d8e0b5 0%, #7a9a30 100%)',
// recipe-photo-4 — wheat / toasted-brown
'linear-gradient(135deg, #d9b88f 0%, #8f5f2b 100%)',
```

### 4. Inline amber hex sweeps

23 files grep-hit on `#fde68a|#fbbf24|#fecaca|#fca5a5|#d9f99d|#a3e635|#713f12|#7f1d1d|#365314|amber-|#B45309|#92400E|#F59E0B`. Agent must:
- Rewrite `HomePage.tsx` `TINTS` array (3 entries): sage/coral/oliv instead of amber/rosa/lime.
- Rewrite `groupAvatarGradient.ts` and related tints to mirror the Home tint palette (source: `variant-a-home.html` `.group-avatar.tint-{1,2,3}`).
- Sweep `RecipeDetailHeader.tsx`, `RecipeForkBanner.tsx`, `GroupDetailHeader.tsx`, `GroupsPage.tsx`, `GroupSwitcher.tsx`, `TopNav.tsx`, `RecipeList.tsx`, `RecipeRevisionDiffModal.tsx`, `CharCounter.tsx`, `AuthLayout.tsx`, `ChefHatLogo.tsx` — replace hardcoded amber/burnt-orange hex (shadows, rgba shadows, accent strips) with sage equivalents using either `hsl(var(--primary))` tokens or the new literal hex above.
- Update tests that bake colors: `button.test.tsx`, `badge.test.tsx`, `input.test.tsx`, `groupAvatarGradient.test.ts`, `HomePage.test.tsx`.

### 5. Any `amber` → `sage` / token comments

- `index.css` comment header: rewrite from "Warme-Küche palette" → "Sage Modern palette".
- `fonts.ts` block comment: rewrite from "Warme-Küche theme" → "Sage Modern theme".
- `button-variants.ts` inline shadow colors: swap `rgba(120,53,15,…)` + `rgba(180,83,9,…)` → sage-shadow rgba values.

### 6. Progress tracker

Append DS8 row to `docs/design-implementation-progress.md` table after review pass.

## Non-goals (explicitly)

- No layout changes, no component restructure, no route changes.
- No new features. No password-change. No photo-upload in create mode. Those stay as AP1/UX1 backlog.
- No dark-mode polish beyond keeping it functional (no new token audit).
- No mockup rebuild of remaining screens (GroupDetail, RecipeDetail, RecipeForm, TagManagement) — real app re-render is the validation.

## Acceptance criteria

- All 446 web tests + 447 .NET tests + 32 shared tests stay green.
- `rg -l 'amber-|#B45309|#92400E|#F59E0B|Cormorant|Libre.Baskerville' apps/web/src` returns **zero hits** (comments, strings, classNames — all of it).
- `pnpm typecheck` + `pnpm lint` clean.
- Visual smoke: Login, Home, GroupDetail, RecipeDetail, RecipeForm, Profile all render with sage primary + coral accent + pure Inter typography. No Cormorant serif left anywhere.
- Button hover stays `hsl(var(--primary-hover))` → sage-dark, **not** white.

## Files touched (estimated)

1. `apps/web/src/index.css` — theme tokens + light + dark
2. `apps/web/src/styles/fonts.ts` — drop Cormorant + Libre
3. `apps/web/src/main.tsx` — comment only
4. `apps/web/src/features/recipes/recipePhotoGradient.ts` — 4 gradients
5. `apps/web/src/features/groups/groupAvatarGradient.ts` + test — tints
6. `apps/web/src/features/home/HomePage.tsx` + test — TINTS array
7. `apps/web/src/features/groups/GroupDetailHeader.tsx` — gradient strip + serif classNames
8. `apps/web/src/features/groups/GroupSwitcher.tsx` — inline hex
9. `apps/web/src/features/groups/GroupsPage.tsx` — inline hex
10. `apps/web/src/features/recipes/RecipeDetailHeader.tsx` — serif className + accent hex
11. `apps/web/src/features/recipes/RecipeForkBanner.tsx` — accent color
12. `apps/web/src/features/recipes/RecipeList.tsx` — accent hex
13. `apps/web/src/features/recipes/RecipeRevisionDiffModal.tsx` — hex
14. `apps/web/src/features/recipes/RecipeGridCard.tsx` — serif
15. `apps/web/src/features/recipes/CharCounter.tsx` — accent
16. `apps/web/src/features/recipes/StepList.tsx` — serif
17. `apps/web/src/features/auth/AuthLayout.tsx` — parchment grid color (already `hsl(var(--primary)/0.06)` → auto-updates; verify)
18. `apps/web/src/features/ratings/RatingWidget.tsx` — serif
19. `apps/web/src/components/brand/ChefHatLogo.tsx` — hex
20. `apps/web/src/components/layout/TopNav.tsx` — hex
21. `apps/web/src/components/ui/button-variants.ts` — shadow rgba
22. `apps/web/src/components/ui/card.tsx` — serif
23. `apps/web/src/components/ui/badge-variants.ts` — hex
24. `apps/web/src/components/NotFoundPage.tsx` — serif
25. `apps/web/src/components/ErrorBoundary.tsx` — serif
26. `apps/web/src/features/stubs/ProfilStub.tsx` — serif
27. `apps/web/src/features/stubs/WochenplanStub.tsx` — serif
28. Five test files — baked color / font assertions

## Anti-shortcut reminders (reviewer enforces)

- No `expect(true).toBe(true)` stubs in new tests.
- Do **not** skip failing tests to "make it pass" — update them to match new tokens with reasoning.
- Do **not** add a `// TODO: fix later` for any amber hex left in.
- Token changes in `index.css` must be reflected in both `:root` **and** `.dark` blocks.
- Font comment in `main.tsx` + `fonts.ts` must mention Inter-only, not carry stale "Warme-Küche" phrasing.

## Dispatch notes

**Impl agent prompt must include:** link to this plan, list of file grep commands to self-verify (`rg 'amber-|#B45309|#F59E0B' apps/web/src`, `rg 'Cormorant|Libre.Baskerville' apps/web/src`), instruction to run `pnpm test && pnpm typecheck && pnpm lint` before declaring done.

**Reviewer agent prompt must include:** independent re-run of the same grep commands, visual check via reading the mockup source to confirm colors match intent, block on any `fix_needed` with concrete file:line pointers.

**Smoke test step (manual, after review accept):** orchestrator starts `pnpm dev` on 5173, opens localhost in browser, clicks Login → Home → Group → Recipe → Profil, reports any visual regression before the user sees it.

**Commit policy:** one commit per logical step (tokens, fonts, gradients, tint sweep, test updates, progress tracker). Orchestrator squashes only if the user asks.
