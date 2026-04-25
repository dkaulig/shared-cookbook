# SETUP — `shared-cookbook`

The runbook for getting `shared-cookbook` running on your own
machine. Goal: anyone with Docker + a text editor boots the stack
in under fifteen minutes.

For the elevator pitch + headline screenshots see [`README.md`](../README.md).
For day-to-day operating rules read [`CLAUDE.md`](../CLAUDE.md).

## Table of contents

1. [Quick context](#1-quick-context)
2. [Prerequisites](#2-prerequisites)
3. [The three boot paths](#3-the-three-boot-paths)
   - [Path 1 — Minimal (no AI, default)](#path-1--minimal-no-ai-default)
   - [Path 2 — Full + Azure OpenAI](#path-2--full--azure-openai)
   - [Path 3 — Full + self-hosted Ollama](#path-3--full--self-hosted-ollama)
4. [Environment variables (catalog)](#4-environment-variables-catalog)
5. [First-boot operator actions](#5-first-boot-operator-actions)
6. [Common gotchas](#6-common-gotchas)
7. [Troubleshooting](#7-troubleshooting)
8. [Test commands](#8-test-commands)
9. [Architecture cheat-sheet](#9-architecture-cheat-sheet)
10. [Where to file issues / contribute](#10-where-to-file-issues--contribute)

## 1. Quick context

`shared-cookbook` is a self-hosted recipe-book PWA with optional
AI-assisted import for blog posts and short-form social videos
(Reels / Shorts / TikTok). The default stack is a single
`docker compose up -d` and ships three services plus the usual
infrastructure:

| Service              | Stack                                          | Role                                                    |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| `api`                | .NET 10 Minimal API + EF Core 10 + Postgres 17 | REST + auth + recipe persistence + Hangfire jobs        |
| `web`                | React 19 + Vite 6 + Tailwind 4 + shadcn/ui     | PWA (offline-first), German UI                          |
| `python-extractor`   | Python 3.13 + FastAPI + yt-dlp + faster-whisper | Video / photo / blog → structured recipe pipeline      |
| `postgres`, `redis`, `seaweedfs`, `caddy` | Postgres 17, Redis 7, SeaweedFS, Caddy 2 | Data, jobs, photos, edge proxy            |
| `ollama` (optional)  | `ollama/ollama:latest`                         | Self-hosted LLM backend (Path 3 only)                   |

The three boot paths in section 3 differ only in which AI backend
you wire up — the manual recipe + meal-plan + shopping-list +
offline-PWA core works on every path.

## 2. Prerequisites

| Tool                      | Required for                                    | Version                  |
| ------------------------- | ----------------------------------------------- | ------------------------ |
| Docker Engine + Compose v2 | All three boot paths                            | Docker 25+, Compose v2   |
| `git`                     | Cloning the repo                                | any recent version       |
| A text editor             | Editing `.env`                                  | any                      |
| `openssl` (or equivalent) | Generating signing keys / passwords             | any                      |
| **Dev-mode only:**        |                                                 |                          |
| `pnpm`                    | Running `apps/web` outside Docker               | 9+                       |
| `.NET 10 SDK`             | Running `apps/api` outside Docker, EF migrations | 10.0+                   |
| `Python 3.13` + `uv`      | Running `apps/python-extractor` outside Docker  | 3.13+, `uv` 0.4+         |

You only need the dev-mode tools if you want to run a service on
the host (hot-reload, debugger). Container-only operation needs
Docker and `git`.

Hardware budget per path (rough):

| Path                | Disk    | RAM      | Notes                                     |
| ------------------- | ------- | -------- | ----------------------------------------- |
| Path 1 (Minimal)    | ~1 GB   | 2 GB     | Boots in < 2 min on a warm Docker daemon. |
| Path 2 (Azure)      | ~5 GB   | 3 GB     | First boot pulls Whisper `large-v3` (~3 GB). |
| Path 3 (Ollama 12B) | ~15 GB  | 16 GB    | 12 GB VRAM strongly recommended; CPU-only works (slow). |

## 3. The three boot paths

### Path 1 — Minimal (no AI, default)

Recommended starting point. No external accounts, no GPU, no AI
credentials. Boots the full app with manual import only.

```bash
git clone https://github.com/kay-solutions/shared-cookbook.git
cd shared-cookbook
cp .env.example .env

# Generate the two secrets you must change. Don't ship the
# CHANGE_ME placeholders into anything you put on the public
# internet.
echo "JWT_SIGNING_KEY=$(openssl rand -base64 48)" >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)" >> .env
# (Open .env afterwards and delete the duplicate placeholder
# lines for those two keys, or leave the new ones at the bottom
# — docker-compose reads the LAST occurrence.)

# Optional but recommended: pick a real admin password.
#   ADMIN_PASSWORD=...   in .env

docker compose up -d
```

Once the API container is healthy (~30–60 s) open
<http://localhost> and log in with `ADMIN_EMAIL` /
`ADMIN_PASSWORD` from your `.env`.

**What works on Path 1:**

- Manual recipe CRUD, photo upload, tag system, versioning, forking
- Group-based sharing with role-based access
- Weekly meal plans + auto-generated shopping lists
- Portion scaling
- "Jetzt kochen" step-by-step Cook-Now mode with wake-lock
- Server-side pagination + cross-group search
- PWA offline-first (background-sync mutations)
- Ratings and comments
- **JSON-LD blog imports** (REL-8) — paste a recipe-blog URL, the
  extractor parses Schema.org `Recipe` JSON-LD directly without any
  LLM call

**What does NOT work on Path 1 (UI hides the relevant CTAs):**

- Photo import (vision-model → 503 `ai_disabled`)
- AI chat / chat-to-recipe
- Video URL import auto-structuring (Reels / TikTok / YT Shorts) —
  the extractor still downloads + transcribes, but you'll get the
  raw text in a textarea to structure manually

The Whisper model prefetch is **skipped** when `AI_ENABLED=false`,
so Path 1 doesn't pay the 3 GB download cost.

### Path 2 — Full + Azure OpenAI

Top-quality AI imports + photo + chat. Requires an Azure OpenAI
resource with `gpt-4.1-mini` (structuring) and `gpt-5.1-chat`
(chat) deployments.

1. Create or reuse an Azure OpenAI resource. See
   <https://learn.microsoft.com/azure/ai-services/openai/how-to/create-resource>
   for the Azure-side walkthrough. Note the resource endpoint, an
   API key, and the deployment names.
2. Start from a working Path 1 `.env`, then add:

   ```env
   AI_ENABLED=true
   LLM_PROVIDER=azure

   AZURE_OPENAI_ENDPOINT=https://<your-resource>.openai.azure.com
   AZURE_OPENAI_API_KEY=<key>
   AZURE_OPENAI_API_VERSION=2025-04-01-preview
   AZURE_OPENAI_DEPLOYMENT_STRUCTURING=gpt-4.1-mini
   AZURE_OPENAI_DEPLOYMENT_CHAT=gpt-5.1-chat
   ```
3. Boot the stack:

   ```bash
   docker compose up -d
   ```

   *(There is no `--profile ai`; the Azure-OpenAI services are part
   of the default compose. The `AI_ENABLED` flag is what the API +
   extractor read at runtime.)*

4. First boot pulls the Whisper `large-v3` weights (~3 GB) into the
   `whisper-models` volume — visible in
   `docker compose logs -f python-extractor`. Subsequent boots hit
   the cache.

Quality + cost notes:

- gpt-4.1-mini is the cost-quality sweet spot for structured
  recipe extraction. Expect a few cents per video import depending
  on transcript length; blog imports are usually < 1 cent.
- Azure OpenAI does **not** use customer data for model training
  by default, but abuse-monitoring logs retain prompts for ~30
  days. See
  <https://learn.microsoft.com/azure/ai-services/openai/how-to/abuse-monitoring>.
- `max_completion_tokens` is capped at 8192 in the extractor.

### Path 3 — Full + self-hosted Ollama

100% local, no cloud, no usage cost — at the price of a beefier
host and ~70–80 % of Azure's structured-output accuracy.

```bash
docker compose --profile ollama up -d
```

`.env` additions:

```env
AI_ENABLED=true
LLM_PROVIDER=ollama

OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=gemma3:12b
OLLAMA_VISION_MODEL=gemma3:12b
```

**Mandatory first-boot step** — pull the model weights once
(~9 GB for Gemma 3 12B):

```bash
docker exec familien-kochbuch-ollama ollama pull gemma3:12b
# Or if you set a different OLLAMA_MODEL:
# docker exec familien-kochbuch-ollama ollama pull qwen2.5:14b
```

Hardware suggestions (operator-side verify on your hardware):

| Class       | Model           | VRAM    | Notes                                   |
| ----------- | --------------- | ------- | --------------------------------------- |
| 12B / 14B   | `gemma3:12b`, `qwen2.5:14b` | ~12 GB  | Recommended quality floor.        |
| 7B / 8B     | `llama3.1:8b`, `mistral:7b` | ~8 GB   | Faster, lower structured-output accuracy. |
| 4B          | `gemma3:4b`     | ~4 GB   | Acceptable on consumer CPUs (~30 s / blog import). |
| CPU-only    | any of the above | n/a    | 12B-class ≈ 2–3 min / import.          |

Photo imports require a multimodal model. `gemma3:12b` is multimodal
so the same tag covers both text + vision; pin
`OLLAMA_VISION_MODEL=llava:13b` or similar if you prefer a
dedicated vision model.

GPU passthrough: uncomment the
`deploy.resources.reservations.devices` block at the bottom of
the `ollama` service in `docker-compose.yml` and install
`nvidia-container-toolkit` on the host. CPU-only falls back
gracefully.

Security note: Ollama exposes its HTTP API without auth. The
default compose keeps the `ollama` service inside the internal
Docker network only (no `ports:` mapping). If you publish the
Ollama port to the host or to the internet, anyone with
network reach can call your model. Either keep it Docker-
internal (default) or front it with your own auth proxy.

## 4. Environment variables (catalog)

Full template in [`/.env.example`](../.env.example). Required-by-path
column maps each variable to where it matters:

| Variable                              | Path 1 | Path 2 | Path 3 | Default                                  | Purpose                                                                                                                          | How to generate                                                                |
| ------------------------------------- | :----: | :----: | :----: | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ADMIN_EMAIL`                         | ✓      | ✓      | ✓      | `admin@example.com`                      | First-boot seeded admin user                                                                                                     | Pick a real address you control                                                |
| `ADMIN_PASSWORD`                      | ✓      | ✓      | ✓      | `CHANGE_ME_admin_password`               | First-boot seeded admin password                                                                                                 | `openssl rand -base64 18`                                                      |
| `ADMIN_DISPLAY_NAME`                  | opt    | opt    | opt    | `Familienkoch`                           | Shows next to "zuletzt geändert" in revision history                                                                             | A real first name                                                              |
| `POSTGRES_DB`                         | ✓      | ✓      | ✓      | `familien_kochbuch`                      | Postgres database name                                                                                                           | —                                                                              |
| `POSTGRES_USER`                       | ✓      | ✓      | ✓      | `app`                                    | Postgres role                                                                                                                    | —                                                                              |
| `POSTGRES_PASSWORD`                   | **✓**  | **✓**  | **✓**  | `dev` (loud insecure default)            | Postgres password                                                                                                                | `openssl rand -base64 24`                                                      |
| `JWT_SIGNING_KEY`                     | **✓**  | **✓**  | **✓**  | `CHANGE_ME_dev_only_jwt_signing_key_min_32_chars` | HMAC-SHA256 key for JWT access tokens AND for signed photo URLs (derived `SHA256("img-sign:" + key)`). MUST be ≥ 256 bits.       | `openssl rand -base64 48`                                                      |
| `APP_FRONTEND_BASE_URL`               | ✓      | ✓      | ✓      | `http://localhost`                       | Used to build invite + password-reset links                                                                                      | Your public URL                                                                |
| `SEAWEEDFS_FILER_URL`                 | opt    | opt    | opt    | `http://seaweedfs:8333`                  | SeaweedFS filer endpoint                                                                                                         | Don't override unless running SeaweedFS off-stack                              |
| `IMAGES_SIGNATURE_VALIDITY_HOURS`     | opt    | opt    | opt    | `2`                                      | Photo-URL signature TTL                                                                                                          | Lower briefly to exercise expiry                                               |
| `EXTRACTOR_SHARED_SECRET`             | opt    | **✓**  | **✓**  | `dev-only-shared-secret`                 | HMAC secret for the .NET ↔ Python service-to-service bridge. **`docker-compose.prod.yml` requires it non-empty.**                | `openssl rand -base64 48`                                                      |
| `PYTHON_EXTRACTOR_BASE_URL`           | opt    | opt    | opt    | `http://python-extractor:8000`           | Override only if running the extractor off-stack                                                                                 | —                                                                              |
| `AI_ENABLED`                          | —      | **✓**  | **✓**  | `false`                                  | Master AI switch. `false` short-circuits providers, hides AI CTAs in UI, skips Whisper prefetch.                                 | `true`                                                                         |
| `LLM_PROVIDER`                        | —      | **✓**  | **✓**  | `disabled`                               | `disabled` / `azure` / `ollama`                                                                                                  | `azure` or `ollama`                                                            |
| `AZURE_OPENAI_ENDPOINT`               | —      | **✓**  | —      | empty                                    | Resource root, no trailing path                                                                                                  | Azure portal                                                                   |
| `AZURE_OPENAI_API_KEY`                | —      | **✓**  | —      | empty                                    | Azure OpenAI key                                                                                                                 | Azure portal                                                                   |
| `AZURE_OPENAI_API_VERSION`            | —      | opt    | —      | `2025-04-01-preview`                     | Pinned per release. Bump only after testing.                                                                                     | —                                                                              |
| `AZURE_OPENAI_DEPLOYMENT_STRUCTURING` | —      | **✓**  | —      | `gpt-4.1-mini`                           | Deployment name for recipe extraction                                                                                            | Match Azure portal deployment names                                            |
| `AZURE_OPENAI_DEPLOYMENT_CHAT`        | —      | opt    | —      | `gpt-5.1-chat`                           | Deployment for AI chat. Falls back to structuring deployment when blank.                                                         | —                                                                              |
| `OLLAMA_BASE_URL`                     | —      | —      | opt    | `http://ollama:11434`                    | Ollama HTTP endpoint                                                                                                             | Don't override on default compose                                              |
| `OLLAMA_MODEL`                        | —      | —      | **✓**  | `gemma3:12b`                             | Text model tag                                                                                                                   | `ollama pull <tag>` first                                                      |
| `OLLAMA_VISION_MODEL`                 | —      | —      | opt    | `gemma3:12b`                             | Multimodal model for photo imports                                                                                               | `ollama pull <tag>` first                                                      |
| `ORCHESTRATOR_PASSWORD`               | opt    | opt    | opt    | empty                                    | When set, seeds the `orchestrator@example.com` bot user (Role=User). Used by Playwright + automation hooks.                      | `openssl rand -base64 18`                                                      |
| `ORCHESTRATOR_PASSWORD_ROTATE`        | opt    | opt    | opt    | empty                                    | Rotation lever; non-empty value forces re-set                                                                                    | —                                                                              |
| `HANGFIRE_WORKERS`                    | opt    | opt    | opt    | `2`                                      | Concurrency cap for extraction jobs                                                                                              | Increase for beefier hosts                                                     |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM_ADDRESS` / `SMTP_FROM_NAME` | opt | opt | opt | empty / `587` / empty / empty / empty / `Familien-Kochbuch` | When unset the API logs reset + invite links to its container log (NoOp sender). Populate for production.                        | Provider's SMTP submission credentials                                         |
| `API_INTERNAL_BASE_URL`               | opt    | opt    | opt    | `http://api:5000`                        | How the python-extractor reaches the API for progress callbacks                                                                  | Don't override on default compose                                              |
| `EXTRACTOR_CONFIG_API_BASE`           | opt    | opt    | opt    | `http://api:5000`                        | Where the extractor pulls hot-configurable settings (prompts / temperature / model)                                              | —                                                                              |
| `PROGRESS_CALLBACK_HOST`              | opt    | opt    | opt    | `api`                                    | SSRF allowlist for callback URLs                                                                                                 | Match service hostname if renamed                                              |

Legend: **✓** = operator MUST set; ✓ = recommended; opt = optional;
— = irrelevant on this path.

## 5. First-boot operator actions

1. **Migrations run automatically** when the API container starts. EF
   Core applies any pending migration in
   `apps/api/src/FamilienKochbuch.Infrastructure/Migrations/` against
   the `__EFMigrationsHistory` table. To roll back a migration use
   `dotnet ef database update <previous-migration>`
   (operator-side, requires the `.NET 10 SDK`).
2. **Default admin user is seeded** if the database has no users —
   credentials come from `ADMIN_EMAIL` / `ADMIN_PASSWORD` /
   `ADMIN_DISPLAY_NAME`. Log in at <http://localhost>.
3. **Default bot user is seeded** when `ORCHESTRATOR_PASSWORD` is
   set — email `orchestrator@example.com`, role `User`. Used by
   Playwright E2E and any automation hook you wire up later.

### Legacy-install migration (pre-REL-0 databases)

If you upgraded from a pre-public-release snapshot, your bot user
still has the historical email
`orchestrator@EXAMPLE_HOST`. Either:

a. Rename it in place:

   ```sql
   UPDATE "AspNetUsers"
   SET "Email" = 'orchestrator@example.com',
       "NormalizedEmail" = 'ORCHESTRATOR@EXAMPLE.COM',
       "UserName" = 'orchestrator@example.com',
       "NormalizedUserName" = 'ORCHESTRATOR@EXAMPLE.COM'
   WHERE "Email" = 'orchestrator@EXAMPLE_HOST';
   ```

b. Or delete the old row and let `SeedDataService` recreate it on
   the next API boot.

### Insecure-default warning — `JWT_SIGNING_KEY`

`apps/api/src/FamilienKochbuch.Api/appsettings.json:7` contains a
hard-coded placeholder

```text
"SigningKey": "CHANGE_ME_IN_ENV_JWT_SIGNING_KEY_MUST_BE_AT_LEAST_32_CHARS"
```

If `JWT_SIGNING_KEY` is missing from `.env` the API falls back to
that placeholder. **This is unsafe for any deployment reachable
from outside your laptop** — the placeholder is in the public
source tree, so anyone can mint valid access tokens against your
instance. Generate a real key with `openssl rand -base64 48` and
put it in `.env` before opening the stack to anything beyond
`localhost`.

The same goes for `POSTGRES_PASSWORD` (default `dev`) and
`EXTRACTOR_SHARED_SECRET` (default `dev-only-shared-secret`). The
production compose (`docker-compose.prod.yml`) actively refuses to
boot with empty values for the latter; the dev compose tolerates
the placeholders so a fresh clone boots without manual setup.

## 6. Common gotchas

- **Whisper first-boot download** — Path 2 / Path 3 first boot
  pulls `large-v3` (~3 GB) into the `whisper-models` named volume.
  The python-extractor health check tolerates the wait
  (`start_period: 300s`); your first video import will still
  block on the prefetch if you trigger it during the download.
- **SeaweedFS retention is unlimited by default.** Recipe photos
  live in the `seaweedfs-data` volume and are never garbage-
  collected automatically. Plan for disk monitoring or implement
  your own retention policy if you'll be storing many photos.
- **Caddy auto-TLS needs a public hostname.** The bundled
  Caddyfile is configured for plain HTTP on `:80` for local dev.
  Production deploys should swap to a Caddyfile with a real
  hostname so Caddy can mint a Let's Encrypt cert. See
  `infra/Caddyfile` for the dev template.
- **EF migrations are forward-only by default.** Rollbacks need
  `dotnet ef database update <previous>` from the host with the
  .NET SDK — there is no in-container rollback CLI. See
  [`CLAUDE.md`](../CLAUDE.md) for the team's migration conventions.
- **`AI_ENABLED=true` without a configured provider** surfaces a
  loud `not_configured` 500 on the first AI call, by design — so
  the operator catches the misconfigure immediately.

## 7. Troubleshooting

| Symptom                                              | First check                                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `docker compose up -d` exits with errors             | `docker compose logs <service>` — usually a missing env var or port `:80`/`:443` already in use.                       |
| Web shows a 500 on every API call                    | `docker compose logs api` — typical cause: malformed Postgres connection string, missing `JWT_SIGNING_KEY`.            |
| Web shows blank page / spinner                       | Hard-refresh (Cmd+Shift+R / Ctrl+Shift+R) to bust the service-worker cache. After major redeploys, re-install the PWA. |
| Photo / video import returns 503 `ai_disabled`       | Path 1: expected, AI is off. Path 2/3: confirm `AI_ENABLED=true` AND `LLM_PROVIDER=azure\|ollama` in `.env`, recreate api + python-extractor containers. |
| Photo / video import returns 500 `not_configured`    | `LLM_PROVIDER` is set but the provider's credentials aren't (Azure key empty, or Ollama model not pulled).             |
| Ollama calls time out                                | `docker exec familien-kochbuch-ollama ollama list` — model pulled? CPU-only on a 12B model can legitimately take 2–3 min. |
| Whisper first import hangs forever                   | `docker compose logs -f python-extractor` — look for `whisper prefetch completed`. Slow uplinks need patience on first boot. |
| Reset / invite emails never arrive                   | SMTP envs blank → links log to `docker compose logs api`. Configure SMTP for production.                               |
| Orchestrator bot can't log in                        | `ORCHESTRATOR_PASSWORD` set in `.env`? Recreate the api container so SeedDataService runs.                             |
| Stack worked yesterday, broken today                 | `docker compose pull && docker compose up -d` — newer images may need newer env vars; diff `.env` against `.env.example`. |

## 8. Test commands

The full set of test + lint commands lives in
[`CLAUDE.md`](../CLAUDE.md) under "Test commands". Short version:

```bash
# Backend
dotnet test apps/api/FamilienKochbuch.sln

# Web (unit + integration)
pnpm --filter web run test

# Shared DTOs
pnpm --filter shared run test

# Python extractor — same four gates that CI enforces
cd apps/python-extractor
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy --strict src tests

# Lint + build
pnpm --filter web run lint
pnpm --filter web run build
dotnet build apps/api/FamilienKochbuch.sln
```

For Playwright E2E specs against the Docker stack see
[`CLAUDE.md`](../CLAUDE.md) → "Local E2E for UI-heavy slices". The
specs target the bot account
(`orchestrator@example.com`, `Role=User`), not the admin user, so
they exercise the real permission path.

## 9. Architecture cheat-sheet

```text
   Browser ──HTTPS──► Caddy ──┬──► Web (React 19 PWA, served as static assets)
                              │
                              └──► API (.NET 10) ──► Postgres 17
                                          │   ├──► Redis (Hangfire jobs)
                                          │   └──► SeaweedFS (recipe photos, signed URLs)
                                          │
                                          └──HMAC-Bearer──► Python Extractor (FastAPI)
                                                                │
                                                                ├──► yt-dlp + faster-whisper (local)
                                                                └──► LLM provider:
                                                                      • disabled (Path 1)
                                                                      • Azure OpenAI (Path 2)
                                                                      • Ollama (Path 3)
```

Service boundaries:

- **Web ↔ API** — JWT-cookie auth (HttpOnly, Secure, SameSite=Lax).
  Refresh tokens persist in the same cookie family.
- **API ↔ Python Extractor** — HMAC-signed bearer over the internal
  Docker network. Shared secret in `EXTRACTOR_SHARED_SECRET`. The
  extractor never accepts external traffic — only Caddy → API.
- **API ↔ SeaweedFS** — Plain HTTP on the internal network. Photo
  reads go through `/api/photos/{**path}` with a per-URL signature
  (TTL `Images__SignatureValidityHours`).
- **API ↔ Postgres / Redis** — Standard drivers (Npgsql,
  StackExchange.Redis).

For deeper architecture decisions (PWA offline strategy, AI
extraction pipeline, component model, …) see the design docs
under [`docs/plans/`](plans).

## 10. Where to file issues / contribute

- **Bugs / feature requests** — GitHub Issues. The project ships
  with [`SECURITY.md`](SECURITY.md) for private-disclosure of
  security issues; please use that channel for anything that
  could affect other operators.
- **Bug history** — [`docs/bugs-backlog.md`](bugs-backlog.md)
  tracks user-reported bugs with their fix-history.
- **Operating rules / contribution conventions** —
  [`CLAUDE.md`](../CLAUDE.md) describes the 4-stage review flow,
  TDD discipline, conventional-commit style, and the design-doc
  requirement for non-trivial slices. Treat it as the
  contributor handbook until a dedicated `CONTRIBUTING.md`
  lands.
