# README.md + SETUP.md content plan

**Date:** 2026-04-22
**Purpose:** break the high-level REL-1 (README rewrite) + REL-6
(SETUP.md HOWTO) slices into concrete section-by-section content
outlines so the implementing sub-agent has a clear brief.

## Doc roles & separation of concerns

| File | Audience | Scope |
|---|---|---|
| `README.md` | GitHub landing-page visitor scrolling for 30 s | What it is, headline screenshots, 30-s boot path, where to go next. No walkthroughs. |
| `docs/SETUP.md` | Someone ready to run it locally | Every env var, three deploy paths (Minimal / +Azure / +Ollama), PWA installation, troubleshooting. |
| `docs/CONTRIBUTING.md` | Someone opening a PR | Test requirements, 4-stage flow pointer, conventional-commit style, how to run the full gate. |
| `docs/SECURITY.md` | Security researcher | Private-disclosure channel (GitHub Security Advisory), in-scope + out-of-scope, response timeline. |
| `CLAUDE.md` | Next Claude session in this repo | Operating rules, test commands, deploy flow. Already exists. |

Everything below scopes **README.md + SETUP.md only** — the other
docs get their own mini-plans within REL-1 / REL-0b.

## `README.md` outline (target: ~200 lines, skimmable)

1. **H1 + tagline**
   - Project name (per repo-rename: `familycookbook` or `open-cookbook` — decided at release time)
   - One-line pitch: *"Self-hosted family recipe-book PWA with optional AI-assisted import from social-video + blogs. Built end-to-end with AI-orchestrated development."*

2. **Status badges**
   - `LICENSE: MIT`
   - `CI: Deploy` (passing / badge)
   - `Tests: 1500+ passing` (static marker, or a Shield.io badge pinned to the dotnet + web + shared counts)
   - Optional: `Stack: .NET 10 + React 19 + Python 3.13`

3. **Headline screenshots / GIF**
   - 3-5 shots placed above the fold: recipe detail page, import from video in progress, Cook-Now two-pane landscape, Admin Extractor-Config page. Use `docs/images/` subfolder, placeholder filenames now, real PNGs from a local screenshot session before going public.

4. **What is it?** (3–5 sentences)
   - Self-hosted PWA.
   - Private family recipe-book with groups + meal-plans + shopping lists.
   - Optional AI-assisted import from FB/IG/TikTok reels + recipe blogs.
   - Works fully offline once loaded (PWA).
   - "Built by AI-orchestrated development" — link to `CLAUDE.md` + `docs/plans/` as a case study.

5. **Key features**
   - Recipe CRUD with photo upload, tag system, versioning, forking.
   - Group-based sharing with role-based access.
   - Weekly meal plans + auto-generated shopping lists.
   - Portion scaling across all ingredients.
   - "Jetzt kochen" step-by-step mode with wake-lock.
   - AI-assisted import (Azure OpenAI *or* self-hosted Ollama).
   - PWA offline-first with background-sync mutations.
   - Server-side pagination + cross-group search.
   - Full admin UI for AI prompts + feature flags (no redeploy for config tweaks).

6. **30-second quick start**
   ```
   git clone <repo>
   cd <repo>
   cp .env.example .env
   docker compose up -d
   open http://localhost
   ```
   → explain: this is the **Minimal path** (no AI), logs you in with the default admin creds baked into `.env.example`. For the full AI setup, link to SETUP.md.

7. **Install on your phone** (short paragraph, 2 bullets)
   - iOS: open in Safari, Share → "Zum Home-Bildschirm".
   - Android: open in Chrome, three-dot menu → "App installieren".
   - Note: after the install, the app appears in the OS share sheet — share a recipe video from any app directly into Familien-Kochbuch.

8. **Architecture at a glance**
   - One diagram (ASCII or a linked image): Caddy → {React web, .NET API} → {Postgres, SeaweedFS, Python extractor → Ollama|Azure}.
   - 2–3 sentence prose after the diagram explaining the separation.

9. **Where to go next**
   - `docs/SETUP.md` — full setup + the three deployment paths (Minimal / Azure / Ollama).
   - `docs/CONTRIBUTING.md` — for contributors.
   - `docs/SECURITY.md` — security disclosure.
   - `CLAUDE.md` — how the codebase is maintained + AI-orchestrated-dev norms.
   - `docs/plans/` — design-docs for every shipped slice, as a living case-study.
   - `docs/bugs-backlog.md` — user-reported bugs with fix-history.

10. **License**
   - "MIT. See `LICENSE`."

## `docs/SETUP.md` outline (target: ~400 lines, runbook-style)

1. **Prerequisites**
   - Docker 25+ with Compose v2.
   - (dev only) pnpm 9+, .NET 10 SDK, `uv` (for the Python extractor).
   - A modern browser + hard-disk space per path:
     - Minimal: ~1 GB.
     - + Azure: ~1.5 GB (no Whisper weights).
     - + Ollama: ~10 GB (Whisper + at least one Ollama model).

2. **Path 1 — Minimal (no AI, default)**
   - Step-by-step commands + first-boot credentials (seed admin).
   - What works: manual recipe CRUD, meal plan, shopping, fork, ratings, PWA offline, JSON-LD blog imports.
   - What doesn't: FB/IG/TikTok video structuring, photo import, chat, AI-tag generation.
   - Troubleshooting box: "Can't log in" / "Seed didn't run" / "Port 80 conflict".

3. **Path 2 — Full + Azure OpenAI**
   - Where to get Azure keys (link to Microsoft's Azure-OpenAI docs).
   - Env-var list with comments:
     - `AZURE_OPENAI_ENDPOINT` / `_API_KEY` / `_API_VERSION` / deployment names.
     - `EXTRACTOR_CONFIG_API_BASE` (internal Docker hostname).
   - `docker compose --profile ai up -d`.
   - First-boot: Whisper `large-v3` downloads ~3 GB into `whisper-models` volume (takes 2–5 min on decent uplink, healthcheck `start_period: 300s` tolerates).
   - Cost disclosure: rough $-per-import estimate for gpt-4.1-mini.

4. **Path 3 — Full + self-hosted Ollama**
   - Add an Ollama container to compose (documented snippet).
   - Model pick:
     - 12 GB VRAM: `gemma3:12b` or `qwen2.5:14b`.
     - 8 GB VRAM: `gemma3:4b` (lower quality, 2-3x faster).
     - CPU-only: `gemma3:4b` at ~30 s/import. `12b`-class at 2–3 min/import.
   - `llm.provider = ollama` in the Extractor-Config admin UI.
   - Vision model note: `gemma3`-vision or `llama3.2-vision` for photo imports.
   - Quality caveat: ~70–80 % of Azure accuracy — occasional manual correction needed.

5. **Install as PWA**
   - iOS: Safari + "Zum Home-Bildschirm". After any manifest change the user has to delete + re-install for share-target / manifest updates to take effect.
   - Android Chrome: menu → "App installieren". Manifest updates apply on next launch.
   - Samsung Internet: menu → "Add page to" → "Home screen".

6. **Web Share Target** (once SHARE-0 ships)
   - iOS: re-install PWA after each manifest change.
   - Android: auto-picks up on next launch.
   - Behaviour: share FB/IG/TikTok reel → app opens at `/share-target` → pre-fills import URL.

7. **Admin setup after first boot**
   - Default admin credentials (in `.env.example`).
   - Recommended first moves: change admin password (Profil-page), create first group, invite family.
   - Tune extractor config (if AI enabled): `/admin/extractor` → prompts, temperature, feature flags.

8. **Database management**
   - Where Postgres lives (named volume `postgres-data`).
   - Backup/restore commands (`docker exec pg_dump` / `psql`).
   - SeaweedFS photo-storage lives in `seaweedfs-data` volume; back it up together with Postgres.
   - Migration history is in EF-Core (`__EFMigrationsHistory` table). Migrations run on API startup; rollback is manual via `dotnet ef migrations remove`.

9. **Observability**
   - Container logs: `docker compose logs -f <service>`.
   - Healthchecks: `docker compose ps` shows `healthy/unhealthy`.
   - Admin: `/admin/ai-usage` for Azure-OpenAI token + cost tracking (if AI enabled).

10. **Common gotchas** (bulleted, one-line each)
   - Whisper first-boot download stalls: check `HF_HOME` env + volume mount.
   - Orchestrator bot isn't seeded: set `ORCHESTRATOR_PASSWORD` in `.env`, recreate API container.
   - Web shows stale UI after deploy: hard-refresh / re-install PWA to bust the service-worker cache.
   - Import stuck at 5 %: usually SSRF guard blocking — check python-extractor logs.
   - Chat streams 500: probably Azure API contract drift (re: `max_completion_tokens` not `max_tokens`, `temperature=1` only).

11. **Development setup** (dev-machine, not Docker)
   - Repo structure overview.
   - Run web in dev-mode: `pnpm --filter web dev`.
   - Run API in dev-mode: `dotnet watch --project apps/api/src/FamilienKochbuch.Api`.
   - Run Python extractor: `uv run uvicorn extractor.main:app --reload --port 8000`.
   - Test commands (web, shared, api, python).
   - Link to `CLAUDE.md` for the 4-stage flow + TDD requirements.

12. **Uninstall / teardown**
   - `docker compose down -v` to nuke everything (including data volumes — destructive, warn clearly).
   - Partial teardown keeping data: `docker compose down` without `-v`.

## Dispatch strategy (for REL-1 + REL-6 sub-agents)

One sub-agent per doc, parallel-safe:
- **REL-1 agent** writes `README.md` per the outline above + creates `LICENSE` file (MIT) + adds `docs/images/` placeholder dir with `.gitkeep`.
- **REL-6 agent** writes `docs/SETUP.md` per the outline + updates `.env.example` with the new inline comments.
- Both agents read this content-plan doc as their brief.

**No code changes** — pure docs + license. Zero test impact.

## Follow-up (not in this plan)

- Screenshot session before public release: capture 3–5 PNGs for README hero + SETUP illustrations.
- `CONTRIBUTING.md` written in its own slice (REL-1b).
- `SECURITY.md` written as part of REL-0b.
