# python-extractor

Familien-Kochbuch Python recipe-extraction microservice.

**Phase 2 scaffold (P2-0).** At this stage the service exposes only a
`GET /health` endpoint. Business logic (URL extraction via `yt-dlp` +
`faster-whisper`, photo extraction via Vision-LLM, AI chat) lands in
subsequent sub-slices — see:

- Parent plan: `../../docs/plans/2026-04-18-phase-2-architecture.md`
- P2-0 plan: `../../docs/plans/2026-04-18-p2-0-python-scaffold.md`

## Stack

- Python 3.13
- [FastAPI](https://fastapi.tiangolo.com/) + [uvicorn](https://www.uvicorn.org/)
- [pydantic](https://docs.pydantic.dev/) / [pydantic-settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/)
- [uv](https://docs.astral.sh/uv/) as package manager (preferred; `pip` alternative below)
- Dev: `pytest`, `pytest-asyncio`, `httpx`, `ruff`, `mypy --strict`

## Local development

```bash
# 1. Install uv if you haven't already:
#    curl -LsSf https://astral.sh/uv/install.sh | sh
#
# 2. Sync the venv with pinned deps (creates .venv under this folder):
uv sync --all-extras

# 3. Run the test suite:
uv run pytest -v

# 4. Lint + format + types:
uv run ruff check .
uv run ruff format --check .
uv run mypy --strict src tests

# 5. Boot the service locally:
uv run uvicorn extractor.main:app --reload --port 8000
curl http://localhost:8000/health
```

### Plain-`pip` alternative

If `uv` is unavailable, you can install the same pinned versions via
standard `pip` inside a `venv`:

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest -v
```

`pyproject.toml` pins are exact (`==`), so both routes resolve to the
same set.

## Docker

```bash
# From the repo root:
docker compose build python-extractor
docker compose up -d python-extractor

# The port is intentionally NOT published to the host — reach it via:
docker exec shared-cookbook-python-extractor curl -s http://localhost:8000/health
```

The .NET API will proxy in P2-6. Frontend never talks to this service
directly.

## Environment

- `SERVICE_NAME` — service identifier, default `extractor`.
- `LOG_LEVEL` — default `INFO`.
- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_VERSION`,
  `AZURE_OPENAI_DEPLOYMENT_STRUCTURING`, `AZURE_OPENAI_DEPLOYMENT_CHAT` —
  consumed from P2-1 onward; present here so `docker compose up` doesn't
  fail on missing values. Each sub-slice that actually uses them validates
  non-empty at its own call site.
- `EXTRACTOR_SHARED_SECRET` — HMAC bridge key for .NET ↔ Python service
  auth (P2-6).
