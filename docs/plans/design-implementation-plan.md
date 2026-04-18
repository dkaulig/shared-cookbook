# Design Implementation Plan (Phase 1.5)

**Goal:** Port the five approved Warme-Küche mockups (`docs/mockups/warme-kueche-*.html`) into real React components inside `apps/web/`, preserving all 638 tests green. Orchestrated autonomously by the assistant; executed by dispatched sub-agents with **TDD**, the existing **anti-shortcut checklist**, and independent review after each slice.

**Reference artefacts:**

- Mockups: `docs/mockups/*.html` — the visual spec. Tokens are documented in `docs/mockups/README.md`.
- Existing React app: `apps/web/src/` — current state after Phase 1 S7. Auth pages, Home, Group pages, Recipe pages, form, history panel, portion scaler all exist functionally with plain shadcn-neutral styling.
- Phase 1 plan + progress: `docs/plans/phase-1-implementation-plan.md`, `docs/phase-1-progress.md`.
- Anti-shortcut checklist: `docs/reviewing/anti-shortcut-checklist.md`.

## Hard rules for every DS sub-agent

Identical to Phase 1 (restated here for clarity):

1. **TDD.** Commit failing tests FIRST where tests apply, then impl. Infra/config-only commits (tsconfig, vite.config, tailwind.config, fonts.css) are TDD-exempt but must still be atomic.
2. **Small commits, push each.**
3. **Push after each commit** to `origin/main`.
4. **German UI strings, English code.**
5. **No deviation from spec** without a tracker note under "Deviations".
6. **Conventions > creativity.** Prefer shadcn primitive composition over custom one-offs where it fits.
7. **No `// TODO`, `Assert.True(true)`, `it.skip`, hollow tests, disabled warnings, hardcoded secrets, `NotImplementedException`.**
8. **`TreatWarningsAsErrors=true`** stays on. TS `strict: true` stays on.
9. **No regression** in the 638 existing tests. If a page's snapshot / DOM test breaks because styling changed, **update the test to the new reality** — don't bypass it, don't delete it. Maintain behavioural coverage.

## Outcome criteria

After DS1–DS7:

- `pnpm dev` on `localhost:5173` (or behind Caddy on `localhost/`) renders Login, Home, Group Detail, Recipe Detail, Recipe Form visually matching their respective mockups on a 375 px viewport.
- All existing tests pass: `dotnet test` = 427/427, `pnpm test -C apps/web` ≥ 179/179, `pnpm test -C packages/shared` = 32/32. Counts may grow as DS slices add visual tests.
- `pnpm lint` clean.
- `docker compose up --build -d` smoke test still passes.
- The mockup HTML files **remain untouched** as a spec.

---

## Slices

### DS1 — Theme Foundation

**Goal:** Every existing React page automatically picks up Warme Küche colors + Cormorant Garamond/Inter/Libre Baskerville typography + new shadcn button variants, without any page-level code changes.

**Deliverables:**

- Install `@fontsource/cormorant-garamond` (wgths 400/500/600/700), `@fontsource/inter` (wghts 400/500/600/700), `@fontsource/libre-baskerville` (wghts 400/400-italic/700). Import the subset CSS in `apps/web/src/main.tsx` or a new `apps/web/src/styles/fonts.ts`. No runtime fetch from Google Fonts.
- Update `apps/web/src/index.css` `:root` block to replace shadcn's neutral palette with Warme Küche tokens (HSL triplets following shadcn convention). Keep the `.dark` block for a minimal usable dark mode that reuses the tokens with inverted lightness. Full dark-mode polish is NOT in DS1 — just ensure nothing looks broken.
  - `--background: 48 100% 96%` (amber-50 / cream)
  - `--foreground: 20 14% 10%` (stone-900)
  - `--primary: 32 95% 37%` (amber-700)
  - `--primary-foreground: 48 100% 96%` (cream)
  - `--destructive: 0 72% 51%` (red-600)
  - `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--border`, `--input`, `--ring` — derived from stone/amber scales per `docs/mockups/README.md`.
  - Document each token choice with a trailing comment showing the hex it maps to.
- Update `apps/web/tailwind.config.ts` (or wherever the config lives — might be Tailwind 4's new `@theme inline` block in `index.css` — inspect first): extend `fontFamily` with:
  - `sans: ['Inter', 'system-ui', 'sans-serif']`
  - `serif: ['"Cormorant Garamond"', 'serif']`
  - `'serif-body': ['"Libre Baskerville"', 'serif']`
- Audit `apps/web/src/components/ui/button-variants.ts` + `button.tsx`. Update the `default` variant to match the mockup's primary button: amber-700 bg, cream text, soft amber shadow, hover amber-800. Keep `secondary`, `ghost`, `outline`, `destructive`, `link` variants aligned too. Size variants unchanged unless needed.
- Ensure `cn()` helper still works; no changes expected there.
- Add (if missing) the shadcn `Card` component at `apps/web/src/components/ui/card.tsx` with the standard shadcn structure (Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter). Light-shadow card style matching mockups.
- Add (if missing) the shadcn `Input` component at `apps/web/src/components/ui/input.tsx` — or if one exists, update padding + focus ring + font-size to match mockup (16px, amber-700 ring).
- Add (if missing) shadcn `Label`, `Textarea`, `Select` components if any DS2–DS7 slice needs them. DS1 is allowed to add primitives eagerly so downstream slices don't block on them.
- Add (if missing) shadcn `Badge` component with the small-tag variant matching the mockup's `.mini-tag`.
- Root element gets `font-sans` class (Inter as default). Headings opt-in to `font-serif` per DS2–DS6 as they land.

**Tests (DS1 adds, existing stays green):**

- Visual smoke tests for each new primitive (Card, Input, Label, Textarea, Badge) via React Testing Library: renders children, respects `className` prop, applies correct variant token class.
- `Button` variant snapshot test updates if the variant class list changed.
- No existing test should require a change unless a token snapshot was pinning a specific color string.

**Acceptance:**

- `pnpm lint` clean. `pnpm -C apps/web test --run` ≥ 179 pass. `dotnet test` = 427 pass. `pnpm -C packages/shared test --run` = 32 pass.
- Boot `apps/web` (`pnpm --filter @familien-kochbuch/web dev` behind Caddy via `docker compose up` OR `pnpm dev -C apps/web` standalone). Visit `http://localhost/login` → primary "Anmelden" button renders amber-700. Body text uses Inter. No console errors.
- `grep -rn "\"sk-\"" apps/web/src packages/` → 0 (no hardcoded secrets). Full anti-shortcut checklist clean.

### DS2 — Auth Flow

**Scope:** Login, Signup, Forgot-Password, Reset-Password pages. Bring them to mockup fidelity (`warme-kueche-login.html`).

**Deliverables:**

- Restyle `apps/web/src/features/auth/LoginPage.tsx` to match mockup: centered card, serif greeting headline, tagline in italic Libre Baskerville, chef-hat logo in the header, "30 Tage angemeldet bleiben"-checkbox wired with Zustand store preserving behaviour, primary "Anmelden" button in amber, divider + invite-note footer.
- Apply the same visual language to `SignupPage.tsx` — kicker "Willkommen in der Familie", inviter name prefetched (already wired in S1), form fields identical style.
- `ForgotPasswordPage.tsx` + `ResetPasswordPage.tsx` — simpler single-field variants, same visual grammar.
- Decorative parchment dotted background applied to the auth shell (not other routes).
- Add `ChefHatLogo.tsx` SVG component in `apps/web/src/components/brand/` — reused across auth + top-navs.
- Preserve every auth test. Update assertion strings if user-visible copy changed slightly (e.g. the mockup uses "Schön, dass du wieder da bist." — if existing tests assert the old copy verbatim, update them).

**Acceptance:**

- Existing auth integration tests in `apps/web` still pass.
- Visiting `/login` on `localhost` visually matches `docs/mockups/warme-kueche-login.html` at 375 px and 1024 px viewports. Take manual note in the review (reviewer doesn't need pixel-perfect comparison, but should say "matches spec").
- Full E2E flow from Phase 1 (signup via invite, login, refresh, logout) still works: `bash scripts/smoke-test.sh` exits 0.

### DS3 — Home & Navigation Shell

**Scope:** `warme-kueche-home.html` plus the top-nav + bottom-nav shell that most inner pages will reuse.

**Deliverables:**

- Create `apps/web/src/components/layout/TopNav.tsx` reflecting the mockup's top bar — brand lockup, search icon, bell with invite badge, avatar. Wire the bell badge to the existing pending-invite query (`useMyReceivedInvites`).
- Create `apps/web/src/components/layout/BottomNav.tsx` — 5 items (Start / Gruppen / + / Wochenplan / Profil), primary FAB-style center button. Wochenplan route is a stub (link to `/wochenplan` with a placeholder page that renders "Bald verfügbar"); Phase 3 will fill it. Profil route similarly stubbed.
- Restyle `HomePage.tsx` (`apps/web/src/features/home/HomePage.tsx` or wherever it lives — search for the existing greeting page):
  - Greeting headline + tagline.
  - Quick-filter chip row (horizontal scroll). Chips just route the user into the Group page with the corresponding filter preselected (or, if no default group, show a modal asking which group). The primary chip is "Schnell"; the rest are stubs that set URL params.
  - "Meine Gruppen" section with group cards (mockup-style: initial avatar with tint, meta row, badge row with Admin/Member + "zuletzt: …"). Reuse existing `useMyGroups()` hook.
  - "Zuletzt gekocht" section with recipe cards (photo gradient placeholder for recipes without real photos, rating pill, tags, meta). Query: recently cooked recipes — reuse whatever exists OR add a small `useRecentlyCooked(groupId?)` hook. If no such data is queryable, fall back to "zuletzt geändert" across all my groups.
  - Received-invites banner (single invite → compact card with inline Accept/Decline; multiple → stacked).
- Apply `TopNav` at the root layout so every protected route gets it. `BottomNav` mounts on mobile via Tailwind `md:hidden`; desktop gets a slimmer side-nav or repositioned header.

**Acceptance:**

- Home renders with all four sections populated from real backend data (or reasonable empties) — no hardcoded mock JSON in prod code.
- Bell shows badge only when invites.pending > 0.
- Wochenplan / Profil tabs open stub pages without errors.
- Tests cover the new components (TopNav, BottomNav, GreetingHeader, QuickFilterRow, RecentRecipesSection, GroupCards).

### DS4 — Group Detail

**Scope:** `warme-kueche-group-detail.html` — cover banner, overlapping avatar (fixed stacking), stats row, filter bar + expanded filter panel, recipe grid, FAB.

**Deliverables:**

- Update `apps/web/src/features/groups/GroupDetailPage.tsx`:
  - Cover banner with the warm amber gradient (or real `coverImageUrl` once available — if not set, show the gradient).
  - Overlapping avatar + name + description layout (as fixed in the mockup post-bug).
  - Stats row with rep counts, member avatar stack, default portions.
  - Filter bar: search input + "Filter (N)"-button with count + "Zufall"-button in accent red.
  - Expanded filter panel with all tag categories grouped, rating slider, prep-time slider, creator dropdown, sort dropdown. Panel togglable; initial collapsed on mobile, expanded on desktop (or collapsed everywhere — pick one and note).
  - Active-filter chips row.
  - Recipe grid — 2 columns mobile, 3–4 desktop.
  - FAB opens the recipe-new route.
- Integrate with existing `useRecipeSearch()` + `useGroupTags()` + `useGroupMembers()` hooks — no new data fetches.
- Handle edge cases: empty group ("Noch keine Rezepte · leg gleich eins an"), filter produces no results ("Kein Treffer · Filter zurücksetzen").

**Acceptance:**

- All existing Group-Detail tests still green.
- Visual match to mockup at 375 px + 1024 px.
- Zufall button still navigates to a random-matching recipe or shows a toast when empty.

### DS5 — Recipe Detail

**Scope:** `warme-kueche-recipe-detail.html` — hero photo, overlapping title card, fork banner, portion stepper + group-default shortcut, meta stat-row, tags, ingredient checklist, numbered step cards, rating widget, history panel, sticky action bar.

**Deliverables:**

- Restyle `apps/web/src/features/recipes/RecipeDetailPage.tsx` end-to-end.
- `HeroPhoto.tsx` component: uses the first photo path, resolved to signed URL via `IPhotoStorage.GetPublicUrl` (already returned by API). Fallback gradient when no photo.
- `PortionStepperCard.tsx` component: replaces the existing `RecipePortionScaler` visual but keeps the scaler logic hook (`scaleIngredients` from `@familien-kochbuch/shared`). The existing `RecipePortionScaler` already handles the math — wrap it with the new visual shell.
- `IngredientChecklist.tsx` component: replaces the existing ingredient list. Rows are tappable, strike-through when checked, green checkmark appears. "Nach Geschmack" rows display italic. State persists for the session (not server — just local UI state).
- `StepList.tsx` component: numbered Cormorant-Garamond bullet + Markdown-rendered content (existing).
- `RatingWidget.tsx`: already exists from S4 — update visual shell only.
- `RecipeHistoryPanel.tsx` (from S6): keep logic, update visual shell to collapsible card.
- `RecipeForkBanner.tsx` (from S5): keep logic, update visual to the warm banner with git-fork icon.
- `RecipeActionBar.tsx` (new): sticky bottom with "In Wochenplan" (ghost) + "Jetzt gekocht" (primary). "Jetzt gekocht" calls a new endpoint or existing `markAsCooked` mutation (add if missing — domain already has `LastCookedAt` field; check if an endpoint exists; if not, log a tracker note and stub the button to a toast "Phase 3").

**Acceptance:**

- All existing Recipe-Detail tests still green.
- Scrolling the page animates the top-bar from transparent to opaque (the JS in the mockup demonstrates this). Reimplement via a scroll-aware React hook.
- Visual match.

### DS6 — Recipe Form

**Scope:** `warme-kueche-recipe-form.html` — form with photo drop-zone, 2-column + full-width details, drag-handle ingredient rows (already wired in S3 fix), numbered step rows, tag picker grouped by category, sticky action bar.

**Deliverables:**

- Restyle `RecipeFormPage.tsx` to the mockup.
- `PhotoUploadGrid.tsx`: 3-slot grid with filled slots + `+` drop-zone placeholder. Reuses existing `useUploadRecipePhoto` mutation.
- `IngredientRow.tsx`: drag handle (@dnd-kit already wired in S3-fix-pass) + quantity input + unit select + name input + note row + scalable pill + remove X. Keep the S3 keyboard-sensor accessibility.
- `StepRow.tsx`: drag handle + numbered avatar + textarea (auto-grow) + remove X.
- `DifficultyPills.tsx`: 3-pill single-select with dots.
- `TagPickerGrouped.tsx`: category-grouped chips with shadcn `Badge` variant switching on selection. "+ Neuen Tag erstellen" opens the existing `CreateCustomTagDialog`.
- Sticky action bar with "Abbrechen" + "Rezept speichern".

**Acceptance:**

- Existing form tests green. New visual tests cover: DifficultyPills single-select behaviour, PhotoUploadGrid slot limit (4th attempt blocked), TagPickerGrouped category rendering.
- Drag-drop reorder (keyboard + pointer) from S3-fix-pass still works.

### DS7 — Polish + PWA

**Scope:** Final polish, PWA manifest update, 404 + loading + error polish, production-compose sanity.

**Deliverables:**

- Update `apps/web/public/manifest.webmanifest` (already has `theme_color: #b45309` from S7 — verify). Update `short_name`, `name`, `lang: "de"`, icon paths.
- Update `apps/web/index.html` `<meta name="theme-color">` to match.
- Global loading skeletons already exist (S7); update them to match the warm palette.
- 404 page: new `NotFoundPage.tsx` with Cormorant-Garamond "404 · Hier kocht niemand" + back-to-home button.
- Error boundary fallback (exists from S7): restyle to warm palette.
- Toast variants (if toasts are used in-app): align to warm colors.
- Final `docs/phase-1-progress.md` addendum: note that DS1–DS7 are complete, all tests green, screenshots captured.
- Final `README.md` screenshot section: take screenshots of Login, Home, Recipe Detail, Group Detail, Recipe Form on mobile viewport, commit them under `docs/screenshots/`, embed in README.

**Acceptance:**

- Full smoke: `docker compose up --build -d && bash scripts/smoke-test.sh && docker compose down` → exit 0.
- `pnpm lint` + `dotnet test` + all test suites green.
- README screenshots present and referenced.
- PWA installable on iOS Safari (manual check) — installs with correct name + icon.

---

## Review protocol (unchanged from Phase 1)

After each DS slice's implementation agent reports done:

**Dispatch a `general-purpose` reviewer agent** (must have Bash) with:

- Commit range (`DSn start..HEAD`).
- Anti-shortcut checklist path.
- This plan's DS slice section.
- Explicit instruction to **run every verification command themselves** — `dotnet test`, `pnpm test`, `pnpm lint`, `docker compose up`, `curl` smoke checks, visual readthrough against the respective mockup file. No trusting of agent claims.

Reviewer updates `docs/design-implementation-progress.md` on decision:

- `pass` → flip DS slice to `done`, commit `chore(review): DSn approved`, push, orchestrator dispatches next.
- `fix_needed` → log specific findings, commit `chore(review): DSn fix-needed — <reason>`, push. Orchestrator dispatches fix agent.

## Orchestrator heartbeat

Same as Phase 1 — notification-driven (background agents fire when done). No explicit polling. Stop conditions: all DS slices `done`, or a blocking design decision that requires user input.
