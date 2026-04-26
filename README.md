# shared-cookbook

> Self-hosted family recipe-book PWA with optional AI-assisted import
> from social-video + recipe blogs. Built end-to-end with
> AI-orchestrated development.

[![CI](https://github.com/dKaulig/shared-cookbook/actions/workflows/ci.yml/badge.svg)](https://github.com/dKaulig/shared-cookbook/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/dKaulig/shared-cookbook?display_name=tag)](https://github.com/dKaulig/shared-cookbook/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Stack](https://img.shields.io/badge/stack-.NET%2010%20%2B%20React%2019%20%2B%20Python%203.13-blueviolet)](#architecture-at-a-glance)

`shared-cookbook` is a private cookbook you host yourself. Invite the
people you cook with, share recipes inside groups, plan the week,
generate the shopping list automatically, and import recipes from a
URL, a video, a photo, or a chat conversation. The UI is multilingual
(German + English), the import pipeline is AI-optional, and the whole
thing runs from a single `docker compose up -d`.

---

## Why does this exist?

Two things at once:

1. **A real product.** Recipe apps either lock you into a SaaS or
   ignore the whole "cook with my family" use-case. `shared-cookbook`
   is invite-only, group-scoped, offline-first (PWA), and runs on a
   single VPS. Photo upload, weekly meal-plan, auto-shopping-list,
   portion scaling, fork-from-other-group, full-text search, ratings,
   "cook now" wake-lock mode.
2. **A full-stack reference codebase built by AI-orchestrated dev.**
   The entire project was implemented through Claude Code with
   sub-agent dispatch, 4-stage review per slice (impl → simplify →
   security → fix-commit → reviewer), TDD discipline, design docs
   under `docs/plans/`, and a rolling bug-backlog. The git history
   literally shows the workflow as commits — see
   [`CLAUDE.md`](CLAUDE.md) for the operating guide and
   [`docs/plans/`](docs/plans/) for the per-slice design docs.

---

## Architecture at a glance

Three services behind a Caddy edge, plus shared infra:

```
                   ┌──────────────┐
                   │  Caddy edge  │  HTTPS / HTTP/3, ACME
                   └──────┬───────┘
                          │
              ┌───────────┴────────────┐
              │                        │
      ┌───────▼───────┐        ┌───────▼────────┐
      │  React 19 PWA │        │  .NET 10 API   │
      │  Vite 6       │        │  Minimal API   │
      │  Tailwind 4   │        │  EF Core 10    │
      │  shadcn/ui    │        │  SignalR       │
      └───────────────┘        └───┬──────┬─────┘
                                   │      │
                ┌──────────────────┘      └──────────────┐
                │                                        │
       ┌────────▼─────────┐                  ┌───────────▼──────────┐
       │  Postgres 17     │                  │  Python 3.13          │
       │  SeaweedFS       │                  │  FastAPI extractor    │
       │  Redis           │                  │  yt-dlp + Whisper +   │
       └──────────────────┘                  │  Azure OpenAI / Ollama│
                                             └───────────────────────┘
```

- **Frontend** — React 19 + Vite 6 + Tailwind 4 + shadcn/ui (New York,
  neutral) + TanStack Query (with persist) + Workbox. Offline-first
  PWA with background-sync mutations. i18n via `react-i18next`
  (German + English).
- **API** — .NET 10 ASP.NET Core Minimal API + EF Core 10 + Postgres
  17 + SignalR for chat + Hangfire for background work. JWT auth,
  group-based authorisation, signed photo URLs.
- **Extractor** — Python 3.13 FastAPI + `yt-dlp` (video download) +
  `faster-whisper` (CPU-local transcription) + `extruct` /
  `recipe-scrapers` (JSON-LD blog parsing) + Azure OpenAI **or**
  self-hosted Ollama for the structuring + vision steps. Reachable
  only on the internal docker network — the .NET API proxies every
  call.

---

## Quick start (30 seconds)

```bash
git clone https://github.com/<your-fork>/shared-cookbook.git
cd shared-cookbook
cp .env.example .env
docker compose up -d
open http://localhost
```

That's the **Minimal path** — no AI required. You get full manual
recipe CRUD, meal-plan, shopping list, portion scaling, ratings,
"cook now" mode, JSON-LD blog imports, and offline PWA. AI features
(structured video / photo / chat imports) stay disabled until you
flip a profile.

The default seeded admin lives in `.env.example`. Change the password
on first login.

For the **+ Azure OpenAI** and **+ self-hosted Ollama** paths (Whisper
weights, model picks, cost estimates), see
[`docs/SETUP.md`](docs/SETUP.md).

---

## Install on your phone

`shared-cookbook` is a PWA. After your first visit:

- **iOS Safari:** Share → "Zum Home-Bildschirm".
- **Android Chrome:** menu → "App installieren".

Once installed, the app appears in the OS share sheet — share a reel
or a recipe URL from any app directly into `shared-cookbook`.

---

## Development setup

The full Docker stack is the easiest way to run the app. For
hot-reloading dev work, run each service natively:

```bash
# Install web dependencies (pnpm workspace).
pnpm install

# Terminal 1 — API + Postgres + Redis + SeaweedFS via Docker.
docker compose up -d postgres redis seaweedfs
dotnet watch --project apps/api/src/SharedCookbook.Api run

# Terminal 2 — Vite dev server (HMR, proxies /api to localhost:5000).
pnpm --filter web dev

# Terminal 3 — Python extractor with reload.
cd apps/python-extractor
uv sync --all-extras
uv run uvicorn extractor.main:app --reload --port 8000
```

Vite serves on <http://localhost:5173>. Caddy is skipped in this
mode — talk to the Vite dev server directly.

---

## Tests

```bash
# .NET — Domain + Infrastructure + Api integration tests.
dotnet test apps/api/SharedCookbook.sln

# Web — Vitest + RTL + MSW.
pnpm --filter web run test

# Shared DTOs.
pnpm --filter shared run test

# Python extractor — match the CI four-gate locally.
cd apps/python-extractor
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy --strict src tests

# Full lint + build.
pnpm --filter web run lint
pnpm --filter web run build
dotnet build apps/api/SharedCookbook.sln
```

Playwright E2E specs live under `apps/web/e2e/`. See
[`CLAUDE.md`](CLAUDE.md) for how to run them against the Docker
stack.

---

## Where to go next

| Doc | What it covers |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Full runbook — env vars, the three deploy paths (Minimal / Azure / Ollama), PWA install, troubleshooting. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute — tiered PR expectations, AI-assisted contributions, locale translations, test commands. |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Private-disclosure channel for security findings. |
| [`docs/SECURITY-AUDIT-2026-04.md`](docs/SECURITY-AUDIT-2026-04.md) | The OWASP Top-10 audit done before going public. |
| [`CLAUDE.md`](CLAUDE.md) | How the codebase is maintained — 4-stage flow, TDD, sub-agent dispatch. |
| [`docs/plans/`](docs/plans/) | Per-slice design docs. The AI-orchestrated-dev case study is in this folder. |
| [`docs/bugs-backlog.md`](docs/bugs-backlog.md) | User-reported bugs with fix-history. |

---

## License

MIT — see [`LICENSE`](LICENSE).

`shared-cookbook` ships alongside a number of third-party
open-source components. The non-trivial ones (Hangfire under LGPL,
Redis 7.4+ under RSALv2/SSPL, plus the broader tally per stack) are
documented in [`NOTICES.md`](NOTICES.md). Nothing in there blocks
self-hosting; the Redis license note is only relevant if you intend
to redistribute `shared-cookbook` as a managed multi-tenant service.

---

## Disclaimer — third-party content

`shared-cookbook` uses [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
to fetch publicly-available video metadata + audio for the user's
own personal use. **It is the user's responsibility to comply with
the source platform's Terms of Service.** This project does not
encourage redistribution of extracted content. Imported recipes,
transcripts, and thumbnails stay inside your self-hosted instance;
nothing leaves except for the optional Azure OpenAI structuring call
(disabled by default).

The German UI label "Familien-Kochbuch" remains as a localised
in-app label for the maintainer's family deployment; the public
project, packages, and documentation use the `shared-cookbook` name.
