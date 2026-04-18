# Infrastructure secrets

How environment variables flow from developer machines / GitHub → the Hetzner VPS.

## The short version

There is **one GitHub secret**, `PROD_ENV`, whose contents are the full `.env` file used on the production VPS. The deploy workflow (`.github/workflows/deploy.yml`) copies it verbatim to `/srv/familien-kochbuch/.env` via SSH on every tagged deploy. Docker Compose reads `${VAR}` expansions from that file.

There are **no** per-variable GitHub secrets for app config. The only per-variable secrets are the ones GitHub Actions itself needs (`VPS_HOST`, `VPS_SSH_USER`, `VPS_SSH_KEY`, `GITHUB_TOKEN` for GHCR).

## Updating `PROD_ENV`

1. GitHub → repo settings → Secrets and variables → Actions → edit `PROD_ENV`.
2. Paste the complete new `.env` content (the format follows `.env.example` exactly).
3. Save. Next tag-triggered deploy picks it up.

Do **not** keep separate copies of the prod `.env` in chat logs, password managers, or local files — `PROD_ENV` is the single source of truth. Local dev uses the unsecret `.env` in the repo root (gitignored).

## Azure OpenAI (Phase 2)

The five `AZURE_OPENAI_*` variables live in `.env.example`. They are **not yet consumed** anywhere — the Python extractor microservice that will read them is part of Phase 2 and has not been built.

Today we ship them as empty / defaulted in `.env.example`. When Phase 2 starts:

1. The user adds the real values (endpoint, api key, deployment names, api version) to `PROD_ENV` on GitHub.
2. `docker-compose.prod.yml` gets a new `python-extractor` service that reads them via `${AZURE_OPENAI_*}`.
3. The Python service reads them at boot via standard `os.getenv()` and passes them to the Azure OpenAI client.

Rule: the API key is **never** baked into a Docker image and **never** shipped to the frontend. It only lives in `PROD_ENV` on GitHub and `/srv/familien-kochbuch/.env` on the VPS.

### Model deployments (as of 2026-04-18)

The linked Azure resource exposes:

- `gpt-4.1`, `gpt-4.1-mini`
- `gpt-5.1`, `gpt-5.1-chat`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`
- `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.3-codex`

Defaults picked in `.env.example`:

| Variable | Default | Why |
|---|---|---|
| `AZURE_OPENAI_DEPLOYMENT_STRUCTURING` | `gpt-4.1-mini` | Strong structured output, cheap, plenty for transcript → recipe JSON |
| `AZURE_OPENAI_DEPLOYMENT_CHAT` | `gpt-5.1-chat` | Conversational-tuned, latest stable chat variant |

Override either per environment by setting a different deployment name in `PROD_ENV` — no code change needed. The deployment name is whatever you named it in the Azure portal; it does not have to match the model id.

## JWT signing key rotation

`JWT_SIGNING_KEY` does double duty: JWT auth tokens **and** the HMAC that signs photo URLs (the HMAC seed is `SHA256("img-sign:" + JWT_SIGNING_KEY)`). Rotating it invalidates:

- all outstanding access tokens (users see a forced re-login on next request — refresh tokens survive)
- every previously-issued signed photo URL (frontend re-fetches via `/api/photos/...` which re-signs)

Generate a new one with `openssl rand -base64 48`, paste into `PROD_ENV`, trigger a deploy.
