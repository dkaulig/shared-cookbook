# Design Implementation — Progress Tracker

**Last updated:** 2026-04-17 (DS1 implementation complete, awaiting review)

Source-of-truth file for DS1–DS7 slice state. Orchestrator and sub-agents update on every tick / completion.

## State legend

- `pending` — not yet started
- `in_progress` — implementation agent running
- `in_review` — impl done, awaiting reviewer
- `fix_needed` — reviewer found issues, fix agent needed
- `done` — reviewed + accepted on `main`
- `blocked` — awaiting user decision

## Slices

| # | Slice | State | Agent | Started | Completed | Notes |
|---|---|---|---|---|---|---|
| DS1 | Theme Foundation (tokens, fonts, shadcn primitives) | in_review | general-purpose (bg) | 2026-04-17 | 2026-04-17 | 16 commits; 207 web tests (+28), 427 .NET, 32 shared; lint clean; docker smoke ok |
| DS2 | Auth Flow (Login, Signup, Forgot, Reset) | pending | — | — | — | — |
| DS3 | Home & Navigation Shell | pending | — | — | — | — |
| DS4 | Group Detail | pending | — | — | — | — |
| DS5 | Recipe Detail | pending | — | — | — | — |
| DS6 | Recipe Form | pending | — | — | — | — |
| DS7 | Polish + PWA | pending | — | — | — | — |

## Last orchestrator tick

- **Time:** 2026-04-17 (DS1 implementation complete)
- **Action:** DS1 Theme Foundation landed across 16 commits (fonts/tokens/Button/Card/Input/Label/Textarea/Select/Badge). All acceptance criteria verified by the implementation agent: 207 web + 427 .NET + 32 shared tests pass, `pnpm lint` clean, `docker compose up` + `/api/health` smoke ok, CSS bundle self-hosts fontsource WOFF2 with zero Google-Fonts references.
- **Next:** dispatch DS1 reviewer agent per the anti-shortcut checklist.

## Blockers / pauses

_(none)_

## Review outcomes

_(none yet)_

**Review standard:** Every review applies `docs/reviewing/anti-shortcut-checklist.md`. Reviewers execute verification commands themselves (dotnet test, pnpm test, lint, docker compose up, visual check against mockup HTML). They do not rely on the implementation agent's claims.

## Deviations from mockup / spec

### DS1

- **Select primitive — native `<select>` instead of `@radix-ui/react-select`.**
  Rationale: only a single-value dropdown is needed in DS4 (creator filter)
  and DS6 (unit picker). A native element saves ~15 KB of Radix JS, keeps
  accessibility free (platform-rendered option list) and avoids pulling a
  new Radix dependency during the theme slice. If a future slice wants a
  styled option list, swap in Radix then.
- **Select chevron painted via `style=` instead of Tailwind `bg-*` utilities.**
  Rationale: tailwind-merge dropped `bg-background` when combined with
  `bg-[right_12px_center]` (both resolve to the `bg` group). Moving the
  chevron metadata to inline style keeps the surface token intact.
- **`--primary-hover` is a DS1-only token (not in shadcn canonical set).**
  Rationale: the mockup button hover drops from amber-700 to amber-800 —
  a literal colour, not an alpha ramp off `--primary`. A named token keeps
  dark-mode overrides clean and is documented in the index.css header.
