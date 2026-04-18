"""FastAPI application entrypoint for the recipe extractor service.

Exposes:
- ``GET /health`` — cheap liveness/readiness probe consumed by the
  Docker HEALTHCHECK and the .NET orchestrator.
- ``POST /extract/url`` — accepts a URL + caller hint, runs the full
  video/blog extraction pipeline, returns a structured recipe result.

Dependencies are injected via FastAPI's ``Depends`` so tests can
override the LLM provider and the video stack (downloader +
transcriber) without touching real Azure / real yt-dlp / real Whisper.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as pkg_version
from typing import Annotated, Final

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field, HttpUrl

from extractor.config import Settings
from extractor.llm import LLMProvider, LLMProviderError, build_provider
from extractor.pipeline.types import ExtractionResult
from extractor.pipeline.url import extract_from_url
from extractor.pipeline.video import (
    ExtractionError,
    Transcriber,
    VideoDownloader,
)

_PACKAGE_NAME: Final[str] = "extractor"

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Response / request models
# ─────────────────────────────────────────────────────────────────────


class HealthResponse(BaseModel):
    """Response model for ``GET /health``.

    Locked down with ``model_config.extra = "forbid"`` so adding a field
    without updating the contract test fails fast rather than silently
    shipping drift.
    """

    status: str = Field(description="Literal 'ok' when the service is up.")
    service: str = Field(description="Service identifier - always 'extractor' here.")
    version: str = Field(description="Package version from installed metadata.")

    model_config = {"extra": "forbid"}


class ExtractHint(BaseModel):
    """Caller-supplied correlation IDs.

    The service doesn't use these for business logic — they're echoed
    through logs + future ``RecipeImport`` records so the Hangfire-side
    job (P2-5) can correlate.
    """

    group_id: str = Field(min_length=1, max_length=200)
    user_id: str = Field(min_length=1, max_length=200)


class ExtractUrlRequest(BaseModel):
    """Body of ``POST /extract/url``."""

    url: HttpUrl = Field(description="Source URL — video host or blog URL.")
    hint: ExtractHint


# ─────────────────────────────────────────────────────────────────────
# Dependency wiring
# ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class VideoStack:
    """Bundle the two video-path components so tests can override both
    with a single ``dependency_overrides`` call."""

    downloader: VideoDownloader
    transcriber: Transcriber


@lru_cache(maxsize=1)
def _get_settings() -> Settings:
    """Singleton ``Settings`` instance."""
    return Settings()


def get_llm_provider() -> LLMProvider:
    """FastAPI dependency returning the configured LLM provider.

    Tests override this to inject a :class:`MockLLMProvider`.
    """
    return build_provider(_get_settings())


def get_video_stack() -> VideoStack | None:
    """FastAPI dependency for the video-path stack.

    Returns ``None`` in production so :func:`extract_from_url` falls
    back to its lazy defaults (``YtDlpDownloader`` +
    ``FasterWhisperTranscriber``). This keeps the Whisper model out of
    memory when the request turns out to be a blog URL — FastAPI runs
    dependencies eagerly before the handler body, so instantiating
    Whisper up-front would burn 3 GB of RAM per request even for blog
    requests. Tests override this to inject a :class:`VideoStack` with
    :class:`StubDownloader` + :class:`StubTranscriber`.
    """
    return None


# ─────────────────────────────────────────────────────────────────────
# Error translation
# ─────────────────────────────────────────────────────────────────────


def _http_from_llm_error(exc: LLMProviderError) -> HTTPException:
    """Map ``LLMProviderError.code`` → the right HTTP status + German message."""
    code = exc.code
    if code == "provider_unavailable":
        return HTTPException(
            status_code=503,
            detail="KI-Service momentan nicht erreichbar. Bitte später erneut versuchen.",
        )
    if code == "rate_limited":
        return HTTPException(
            status_code=503,
            detail=(
                "KI-Service drosselt gerade zu viele Anfragen. Bitte kurz warten "
                "und erneut versuchen."
            ),
        )
    if code == "not_configured":
        # Service misconfig: admin-facing. Log at ERROR and hide the
        # internal message from the caller.
        logger.error("LLM provider not configured: %s", exc)
        return HTTPException(status_code=500, detail="KI-Service ist nicht konfiguriert.")
    # auth_failure / invalid_request / schema_mismatch — all service bugs
    # from the caller's perspective. Generic 500 + log.
    logger.error("LLM provider error code=%s msg=%s", code, exc)
    return HTTPException(status_code=500, detail="Interner Fehler bei der KI-Verarbeitung.")


def _http_from_extraction_error(exc: ExtractionError) -> HTTPException:
    """Map :class:`ExtractionError.code` → HTTP status."""
    if exc.code == "source_unavailable":
        # The URL is the caller's mistake (private / dead link) — 422.
        return HTTPException(status_code=422, detail=str(exc))
    # transcription_failed — model trouble. 500.
    return HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────
# App factory
# ─────────────────────────────────────────────────────────────────────


def _resolve_version() -> str:
    """Resolve the package version from installed metadata.

    Falls back to ``"0.0.0+unknown"`` when the package isn't installed
    (e.g. running ``python -m extractor.main`` directly from a source
    checkout without ``pip install -e .``). In all supported paths
    (editable dev install, Docker image, CI) the metadata is present.
    """
    try:
        return pkg_version(_PACKAGE_NAME)
    except PackageNotFoundError:
        logger.warning(
            "Package metadata for %r not found; falling back to 0.0.0+unknown. "
            "Run `uv sync --all-extras` or `pip install -e .` to install the "
            "package in editable mode.",
            _PACKAGE_NAME,
        )
        return "0.0.0+unknown"


def create_app() -> FastAPI:
    """Build a fresh FastAPI instance.

    Using a factory (rather than a module-level ``app = FastAPI()``)
    makes it trivial to spin up isolated instances per test, avoids
    accidental cross-test state, and keeps the app's dependency graph
    explicit.
    """
    application = FastAPI(
        title="Familien-Kochbuch Extractor",
        description=(
            "Internal recipe-extraction microservice. Not exposed to end users - "
            "the .NET API proxies all requests."
        ),
        version=_resolve_version(),
    )

    @application.get("/health", response_model=HealthResponse, tags=["health"])
    def health() -> HealthResponse:
        """Return a cheap liveness payload."""
        return HealthResponse(
            status="ok",
            service=_PACKAGE_NAME,
            version=_resolve_version(),
        )

    @application.post("/extract/url", tags=["extract"])
    async def extract_url(
        request: ExtractUrlRequest,
        provider: Annotated[LLMProvider, Depends(get_llm_provider)],
        video_stack: Annotated[VideoStack | None, Depends(get_video_stack)],
    ) -> ExtractionResult:
        """Run the URL → structured-recipe pipeline.

        Translates pipeline errors to HTTP:
        - :class:`LLMProviderError` → 503 (``provider_unavailable`` /
          ``rate_limited``), 500 otherwise.
        - :class:`ExtractionError` ``source_unavailable`` → 422,
          ``transcription_failed`` → 500.
        """
        logger.info(
            "extract_url request group_id=%s user_id=%s",
            request.hint.group_id,
            request.hint.user_id,
        )
        downloader = video_stack.downloader if video_stack is not None else None
        transcriber = video_stack.transcriber if video_stack is not None else None
        try:
            return await extract_from_url(
                str(request.url),
                provider=provider,
                downloader=downloader,
                transcriber=transcriber,
            )
        except LLMProviderError as exc:
            raise _http_from_llm_error(exc) from exc
        except ExtractionError as exc:
            raise _http_from_extraction_error(exc) from exc

    return application


# Module-level ASGI handle for uvicorn / the Docker CMD.
# `uvicorn extractor.main:app` looks this name up on import.
app: FastAPI = create_app()
