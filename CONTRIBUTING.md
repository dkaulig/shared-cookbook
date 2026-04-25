# Contributing to shared-cookbook

Thanks for taking an interest in `shared-cookbook`. This guide explains
how the project accepts contributions, what we expect in a PR, and how
we communicate.

## Hobby OSS — honest expectations

`shared-cookbook` is a hobby open-source project maintained by one
person in their spare time. Realistic expectations:

- Issue triage and PR review usually happen within **a few days to a
  couple of weeks**, not 24 hours. If something is on fire (security,
  data loss), say so explicitly in the issue title.
- The project's roadmap is driven by what the maintainer's family
  actually wants from a cookbook. External feature requests are
  welcome but won't always land.
- We don't have a paid support channel. GitHub Issues and Discussions
  are the primary contact surface.

If that fits your expectations, read on.

## Getting started

The full setup, env vars, and deploy paths live in
[`docs/SETUP.md`](docs/SETUP.md). Don't duplicate that here — start
there for installation, then come back for contribution conventions.

Quickstart for the impatient:

```bash
docker compose up -d
pnpm install
```

See `docs/SETUP.md` for the env-var matrix, the three deploy paths
(Minimal / Azure / Ollama), and PWA-install notes.

## Types of contributions we welcome

### Locale translations

The UI is multilingual. Translation files live in
[`apps/web/src/locales/`](apps/web/src/locales/) — currently `de` and
`en`. To add a language or fix a wording:

1. Copy `en/` (or `de/`) to a new locale folder named with the ISO
   code (e.g. `fr`, `es`).
2. Translate the JSON files.
3. Wire the new locale into the i18n config (search for the locale
   array — small, central spot).
4. Open a PR — locale PRs count as **small PRs** (see below).

### Bug fixes

- **Small bugs** (single file, obvious cause, clear fix): open a PR
  directly. No issue first.
- **Larger bugs** (multi-file changes, unclear root cause, behaviour
  shift): open an issue first so we can align on the fix before you
  invest time. Use the Bug-report issue template.

### Documentation

Doc fixes are always welcome. Typo, broken link, outdated command,
missing step in `docs/SETUP.md` — open a PR.

### Feature requests

Open an issue with the Feature-request template **before** writing
code. Features need direction-alignment because the roadmap is
intentionally narrow. A short discussion in the issue saves everyone
time vs. a closed PR.

## Tiered PR expectations

Not every PR needs a design doc. We use two tiers:

### Small PRs

Examples: typo fix, locale-string change, single-file bug fix, dep
bump, isolated docs edit.

Requirements:

- Tests green for the area you touched.
- Lint clean.
- Conventional Commits in the commit message (see below).
- No issue-first required — open the PR directly.

### Larger PRs

Examples: new feature, multi-file refactor, schema change, new
external dependency, anything that crosses a service boundary
(web / api / extractor).

Requirements:

- Issue first. Brief discussion of the use case and intended
  approach. The maintainer may suggest scope changes before you
  invest time.
- A simple plan in the PR description — what changes, how, why this
  approach over alternatives. No formal design doc required for
  community contributions.
- Tests for new behaviour. Test-driven development is **encouraged
  but not enforced** for community PRs — internal slices use TDD
  by default, but we won't block your contribution on test-order.
- Conventional Commits.

The tiered approach exists so first-time contributors aren't blocked
by process for small fixes, while larger changes still get the
discussion they need.

## Coding standards

Keep these in mind when writing code:

- **Conventional Commits** for the subject line:
  `feat(scope): subject`, `fix(scope): subject`, `docs(scope): ...`,
  `chore(scope): ...`. Common scopes: `web`, `api`, `extractor`,
  `shared`, `contrib`, `docs`.
- **Tests + lint green** before you push. See "Test commands" below.
- **Code comments in English.** User-facing strings are translated
  via i18n; code comments stay English so contributors from any
  locale can read them.
- **User-facing strings via i18n.** Don't hard-code German or English
  text in components. Add a key under `apps/web/src/locales/<lang>/`
  and reference it from the component.
- **Don't commit secrets.** `.env`, credential files, API keys — none
  of these belong in the repo. The `.gitignore` covers the obvious
  cases; double-check before `git add`.

## AI-assisted contributions

This project is itself a case study in AI-orchestrated development —
see the README's "AI-orchestrated dev" framing and the per-slice
design docs in [`docs/plans/`](docs/plans/). AI-assisted contributions
are **explicitly welcome and encouraged**.

If you used Claude, GPT, Cursor, Copilot, or any other AI tool to
help write your PR:

1. **You reviewed the changes.** AI suggestions are a starting
   point, not a finished product. Read every line, run the tests,
   verify the behaviour. "AI did it" is not an acceptable explanation
   for a bug or a security regression — the contributor owns the PR.
2. **Add a `Co-Authored-By` trailer** to your commit messages so the
   provenance is honest:

   ```
   feat(web): add French locale

   Co-Authored-By: Claude Opus 4.X <noreply@anthropic.com>
   ```

   Use whatever model name + email pair fits the tool you used. The
   trailer is just an honest signal, not a legal claim.
3. **No extra burden** beyond review + attribution. We don't require
   you to disclose the prompts you used or the % of code that was
   AI-generated. Treat it like any other tooling.

If you didn't use AI, no trailer needed — write your PR as normal.

## Test commands

Run the suite for the area you touched. Full details live in
[`docs/SETUP.md`](docs/SETUP.md); this is the quick reference:

```bash
# Web (React + Vite + Tailwind)
pnpm --filter web run test
pnpm --filter web run lint
pnpm --filter web run build

# Shared TS package
pnpm --filter shared run test

# .NET API
dotnet test apps/api/SharedCookbook.sln
dotnet build apps/api/SharedCookbook.sln

# Python extractor
cd apps/python-extractor
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy --strict src tests
```

For UI-heavy changes, the Playwright E2E suite lives in
`apps/web/e2e/`. See `docs/SETUP.md` for the docker-stack run mode.

## Pull request flow

1. Fork the repo and branch from `main`.
2. Make your change. Keep PRs focused — one logical change per PR.
3. Run the relevant tests + lint locally.
4. Push and open a PR. The PR template will prompt for summary,
   related issue, test plan, and AI-assisted disclosure.
5. The maintainer reviews. Expect a few days for the first round.
6. Address feedback with new commits (don't force-push unless asked).
7. Once approved, the maintainer merges.

## License

`shared-cookbook` is MIT-licensed — see [`LICENSE`](LICENSE).

By contributing, you agree that your contributions will be licensed
under the MIT License. We don't require a separate CLA or DCO
sign-off — submitting a PR is your agreement.

## Maintainer + response time

- **Primary channel:** [GitHub Issues](https://github.com/dKaulig/shared-cookbook/issues)
  for bugs and features, [GitHub Discussions](https://github.com/dKaulig/shared-cookbook/discussions)
  for open-ended questions.
- **Security disclosures:** see [`docs/SECURITY.md`](docs/SECURITY.md).
  Don't file a public issue for a vulnerability.
- **Response time:** typically days, sometimes a couple of weeks.
  Hobby OSS — not a paid product. Be patient, and feel free to
  bump a stale thread once after two weeks of silence.

Thanks for considering a contribution.
