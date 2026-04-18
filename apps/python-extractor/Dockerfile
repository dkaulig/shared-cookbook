# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the Familien-Kochbuch recipe-extractor service.
#
# Stage 1 (builder): uses `uv` to resolve + install pinned deps into a
# self-contained /app/.venv. We prefer `uv sync --frozen` so the image
# fails closed if the lockfile drifts from pyproject.toml.
#
# Stage 1a (whisper-model): pre-downloads the faster-whisper large-v3
# weights into the venv's HuggingFace cache so runtime never fetches
# from the network. Added ~3 GB to the final image (expected).
#
# Stage 2 (runtime): copies the venv + model cache + source into a slim
# Python base, drops to a non-root user, and runs uvicorn. `curl` is
# kept in the runtime image so HEALTHCHECK can hit /health without an
# external binary dependency. `ffmpeg` is required by yt-dlp for audio
# extraction from the downloaded videos.
#
# Image size after P2-2: ~3.5 GB (whisper large-v3 weights dominate).
# Build time: +2-3 minutes for the model download step.

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
# Stage 1a — whisper-model: pre-download large-v3 into /root/.cache.
# Done as a dedicated layer so model-download churn doesn't invalidate
# the deps layer above. The cache lives at /root/.cache/huggingface
# in the builder and is copied into the runtime image below.
# ─────────────────────────────────────────────────────────────────────
FROM builder AS whisper-model

ENV HF_HOME=/root/.cache/huggingface \
    PATH="/app/.venv/bin:${PATH}"

# Calls WhisperModel(...) which triggers the HuggingFace snapshot
# download of the large-v3 weights + tokenizer. Runs once at build
# time; the runtime stage copies the populated cache.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('large-v3', device='cpu', compute_type='int8')"

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

# Pre-downloaded faster-whisper model weights. Copied into the
# non-root user's home so runtime HF loading reads from /app/.cache
# (matches HF_HOME below).
COPY --from=whisper-model --chown=extractor:extractor /root/.cache/huggingface /app/.cache/huggingface

# Make the venv's Python + scripts the default on PATH.
# HF_HOME pins the HuggingFace cache to the location we just copied
# so faster-whisper hits the baked-in weights and never reaches the
# network at runtime.
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    HF_HOME=/app/.cache/huggingface

USER extractor

EXPOSE 8000

# Matches the cadence used by the other services in the compose stack.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent http://localhost:8000/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "extractor.main:app", "--host", "0.0.0.0", "--port", "8000"]
