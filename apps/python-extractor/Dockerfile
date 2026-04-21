# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the Familien-Kochbuch recipe-extractor service.
#
# Stage 1 (builder): uses `uv` to resolve + install pinned deps into a
# self-contained /app/.venv. We prefer `uv sync --frozen` so the image
# fails closed if the lockfile drifts from pyproject.toml.
#
# Stage 2 (runtime): copies the venv + source into a slim Python base,
# drops to a non-root user, and runs uvicorn. `curl` is kept in the
# runtime image so HEALTHCHECK can hit /health without an external
# binary dependency. `ffmpeg` is required by yt-dlp for audio extraction
# from the downloaded videos.
#
# Whisper model weights are NOT baked into the image — they live in a
# named docker volume mounted at ``$HF_HOME`` (see docker-compose*.yml).
# The volume survives image redeploys so the ~3 GB large-v3 download
# happens exactly once per host, not once per deploy. ``main.py`` kicks
# off a best-effort background prefetch on startup so the first real
# transcription call isn't blocked on the HuggingFace round-trip.

ARG PYTHON_VERSION=3.13-slim

# ─────────────────────────────────────────────────────────────────────
# Stage 1 — builder: resolves deps into /app/.venv using uv.
# ─────────────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION} AS builder

# Copy the static uv binary from the official uv image rather than
# curl|sh at build time — reproducible, no network fetch in the RUN.
COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /uvx /usr/local/bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app

# Dep-only layer first — changes to src/** don't bust the lock layer.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# Now copy the actual package + install it into the venv.
COPY src/ ./src/
COPY README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# ─────────────────────────────────────────────────────────────────────
# Stage 2 — runtime: slim, non-root, healthchecked.
# ─────────────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION} AS runtime

# `curl` for the HEALTHCHECK; `tini` as PID 1 to reap zombies + forward
# signals correctly to uvicorn. `ffmpeg` is yt-dlp's audio-extraction
# dependency — required for the video-path pipeline.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl tini ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Non-root user (uid 1001 matches the plan).
RUN groupadd --system --gid 1001 extractor \
    && useradd --system --uid 1001 --gid 1001 --home /app --shell /usr/sbin/nologin extractor

WORKDIR /app

COPY --from=builder --chown=extractor:extractor /app/.venv /app/.venv
COPY --from=builder --chown=extractor:extractor /app/src /app/src

# Pre-create the HuggingFace cache dir so the named-volume mount has a
# sane owner even on first boot. Weights stream in at runtime on first
# transcription (or the startup prefetch — see main.py lifespan).
RUN mkdir -p /home/app/.cache/huggingface \
    && chown -R extractor:extractor /home/app

# Make the venv's Python + scripts the default on PATH. HF_HOME pins
# the HuggingFace cache to the mounted named volume so faster-whisper
# finds the weights across container restarts without re-downloading.
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    HF_HOME=/home/app/.cache/huggingface

USER extractor

EXPOSE 8000

# Matches the cadence used by the other services in the compose stack.
# ``start_period`` is generous (300 s) to tolerate the first-boot model
# download when the named volume is empty — compose overrides this
# further where needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
    CMD curl --fail --silent http://localhost:8000/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "extractor.main:app", "--host", "0.0.0.0", "--port", "8000"]
