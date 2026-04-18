# P2-0 — Python Service Scaffold

**Slice:** P2-0 (first Phase 2 sub-slice)
**Status:** planned
**Date:** 2026-04-18
**Depends on:** Phase 1.5 complete.
**Parent plan:** `docs/plans/2026-04-18-phase-2-architecture.md`.

## Why

Phase 2 needs a new Python microservice. This slice creates the **smallest viable scaffold**: FastAPI + Docker + CI + one `/health` endpoint. No business logic, no LLM calls, no `yt-dlp`. Those land in P2-1 onward. The goal is a green container + green test job so subsequent slices plug into existing infrastructure.

## Scope

### 1. Package structure

New tree under `apps/python-extractor/`:

```
apps/python-extractor/
├─ pyproject.toml           # Python 3.13, deps + dev-deps pinned
├─ uv.lock                  # (or equivalent, generated)
├─ Dockerfile               # multi-stage (builder + runtime)
├─ .dockerignore
├─ README.md                # short; points at parent plans
├─ src/
│  └─ extractor/
│     ├─ __init__.py
│     ├─ main.py            # FastAPI app factory + /health endpoint
│     └─ config.py          # env-var loader (pydantic-settings)
└─ tests/
   ├─ __init__.py
   ├─ conftest.py           # pytest fixtures (FastAPI TestClient)
   └─ test_health.py        # smoke test for /health
```

### 2. Dependencies (pinned)

Runtime:
- `fastapi` (latest stable — let the agent pin at install time)
- `uvicorn[standard]` (ASGI server for local + container)
- `pydantic`
- `pydantic-settings` (env-var config)

Dev:
- `pytest`
- `pytest-asyncio`
- `httpx` (FastAPI's `TestClient` uses it)
- `ruff` (lint + format, replaces black + flake8)
- `mypy` (strict type checking)

**No LLM or yt-dlp dependencies yet** — those join in P2-1 / P2-2.

### 3. `GET /health` endpoint

Returns:
```json
{ "status": "ok", "service": "extractor", "version": "0.1.0" }
```

The `version` reads from `pyproject.toml` at module load (not hard-coded) so future deploys don't accidentally ship mismatched versions. Implementation via `importlib.metadata.version("extractor")` after the package is installed in editable mode.

### 4. Config module

`src/extractor/config.py`:

```python
class Settings(BaseSettings):
    service_name: str = "extractor"
    log_level: str = "INFO"
    # Azure OpenAI placeholders — consumed from P2-1 onward.
    # Present here so `docker compose up` doesn't fail on missing envs;
    # each sub-slice that actually uses them validates non-empty at its
    # own call site.
    azure_openai_endpoint: str = ""
    azure_openai_api_key: str = ""
    azure_openai_api_version: str = "2025-04-01-preview"
    azure_openai_deployment_structuring: str = "gpt-4.1-mini"
    azure_openai_deployment_chat: str = "gpt-5.1-chat"
    extractor_shared_secret: str = ""  # P2-6 HMAC bridge
    model_config = SettingsConfigDict(env_file=None)
```

### 5. Dockerfile (multi-stage)

```
FROM python:3.13-slim AS builder
# Install uv (fast Python package manager)
# Install deps into a venv

FROM python:3.13-slim AS runtime
# Non-root user (uid 1001)
COPY --from=builder /app/.venv /app/.venv
COPY src /app/src
WORKDIR /app
EXPOSE 8000
HEALTHCHECK CMD curl -f http://localhost:8000/health || exit 1
CMD ["/app/.venv/bin/uvicorn", "extractor.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Image size target: <300 MB at this stage (grows in P2-2 when yt-dlp + whisper join).

### 6. Docker Compose wiring

Add `python-extractor` service to `docker-compose.yml`:

```yaml
python-extractor:
  build: ./apps/python-extractor
  container_name: familien-kochbuch-python-extractor
  environment:
    AZURE_OPENAI_ENDPOINT: ${AZURE_OPENAI_ENDPOINT:-}
    AZURE_OPENAI_API_KEY: ${AZURE_OPENAI_API_KEY:-}
    AZURE_OPENAI_API_VERSION: ${AZURE_OPENAI_API_VERSION:-2025-04-01-preview}
    AZURE_OPENAI_DEPLOYMENT_STRUCTURING: ${AZURE_OPENAI_DEPLOYMENT_STRUCTURING:-gpt-4.1-mini}
    AZURE_OPENAI_DEPLOYMENT_CHAT: ${AZURE_OPENAI_DEPLOYMENT_CHAT:-gpt-5.1-chat}
    EXTRACTOR_SHARED_SECRET: ${EXTRACTOR_SHARED_SECRET:-dev-only-shared-secret}
  expose:
    - "8000"
  depends_on:
    postgres:
      condition: service_healthy
  restart: unless-stopped
```

Same structure in `docker-compose.prod.yml` (different image source: `ghcr.io/kay-solutions/familien-kochbuch-python-extractor:latest` like the other services).

**Not exposed to the host** — only reachable on the internal docker network. `.NET` will proxy in P2-6.

### 7. `.env.example` update

Add `EXTRACTOR_SHARED_SECRET=` placeholder. The five `AZURE_OPENAI_*` vars already live there.

### 8. GitHub Actions `test-python` job

Add a new job to both `.github/workflows/ci.yml` (push + PR) and `.github/workflows/deploy.yml` (tag-triggered) that runs:
- `uv sync --all-extras`
- `ruff check .`
- `ruff format --check .`
- `mypy src tests`
- `pytest -v`

Runs in parallel with the existing `test-api`, `test-web`, `test-shared` jobs (matches the user's preference set in earlier slices).

Also add a Docker build step in `deploy.yml` next to the existing api + web image builds, pushing to `ghcr.io/kay-solutions/familien-kochbuch-python-extractor`.

### 9. Tests

`tests/test_health.py`:
- `GET /health` returns 200 with the expected JSON shape.
- `status == "ok"`.
- `service == "extractor"`.
- `version` is a non-empty string.

That's it for P2-0. More tests land in P2-1 onward.

## Non-goals (explicit)

- No Azure OpenAI integration yet (P2-1).
- No yt-dlp, no whisper (P2-2).
- No Hangfire wiring (P2-5).
- No .NET proxy (P2-6).
- No browser UI surface (P2-7+).

## Acceptance criteria

- `docker compose build python-extractor` succeeds locally.
- `docker compose up -d python-extractor` brings it up healthy within 30 seconds.
- `curl http://localhost:8000/health` (from inside the container's network, e.g. via `docker exec`) returns the JSON shape.
- `cd apps/python-extractor && pytest -v` green, `ruff check` green, `mypy` green.
- The new `test-python` job appears on the GitHub Actions matrix and (if the agent pushes a test branch) runs green.
- All existing web (548) + .NET (474) + shared (32) tests stay green. Zero backend / frontend / shared changes (other than docker-compose additions).

## Anti-shortcut reminders

- TDD for the `/health` test: write the test first, then the endpoint.
- Strict typing: `mypy --strict` must pass. No `# type: ignore` without a named reason.
- No `print()` for logging — use the standard `logging` module with a named logger.
- Non-root container user.
- Pin dependency versions in `pyproject.toml`. Do not use floating `^` ranges that silently upgrade.
- Do not add `azure-openai`, `openai`, `yt-dlp`, `whisper`, `faster-whisper`, or any heavyweight deps in P2-0. Those are later-slice work.

## Dispatch notes

**Impl agent:**
- This is a greenfield directory. No need to grep existing code beyond the shared package.
- Work order: `pyproject.toml` + package skeleton → health test → health endpoint → Dockerfile → docker-compose wiring → CI job → final verification.
- Choose `uv` as the package manager (modern, fast, matches current Python tooling best-practice). If the agent is more comfortable with plain `pip-tools`, that's acceptable — document the choice in the first commit.
- Run from `apps/python-extractor`:
  - `pytest -v 2>&1 | tail -10`
  - `ruff check . 2>&1 | tail -5`
  - `mypy src tests 2>&1 | tail -5`
- Also run existing gates once: `cd apps/web && pnpm test --run && pnpm build && pnpm lint && cd ../api && dotnet test --nologo`.
- Docker build smoke: `docker compose build python-extractor && docker compose up -d python-extractor && docker exec familien-kochbuch-python-extractor curl -s http://localhost:8000/health` — confirm the payload.
- Commit per step, Co-Authored-By footer.

**Reviewer agent:**
- Confirm Dockerfile uses non-root user.
- Confirm no heavyweight deps slipped in.
- Confirm CI job parallel-runs with api/web/shared.
- Run pytest / ruff / mypy / docker-build gates.
