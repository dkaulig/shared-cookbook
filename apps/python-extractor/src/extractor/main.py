"""FastAPI application entrypoint for the recipe extractor service.

Exposes:
- ``GET /health`` — cheap liveness/readiness probe consumed by the
  Docker HEALTHCHECK and the .NET orchestrator.
- ``POST /extract/url`` — accepts a URL + caller hint, runs the full
  video/blog extraction pipeline, returns a structured recipe result.
- ``POST /extract/photos`` — accepts 1..10 signed photo URLs + caller
  hint, runs the Vision-LLM pipeline, returns the same structured
  recipe shape (P2-3).
- ``POST /chat`` — one conversational turn with the koch-assistent.
- ``POST /chat/{session_id}/to-recipe`` — verdichte den Dialog zu
  einem strukturierten Rezept.

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
from typing import Annotated, Final, Literal

from fastapi import Depends, FastAPI, HTTPException, Response
from pydantic import BaseModel, Field, HttpUrl

from extractor.config import Settings
from extractor.llm import ChatMessage, LLMProvider, LLMProviderError, TokenUsage, build_provider
from extractor.pipeline.chat import (
    EmptyMessagesError,
    MessagesTooLongError,
    chat_to_recipe,
    chat_turn,
)
from extractor.pipeline.photo import extract_from_photos
from extractor.pipeline.types import ExtractionResult
from extractor.pipeline.url import extract_from_url
from extractor.pipeline.video import (
    ExtractionError,
    Transcriber,
    VideoDownloader,
)
from extractor.security import HmacVerificationMiddleware

_PACKAGE_NAME: Final[str] = "extractor"

# PF2 response-header names for token-usage propagation. The .NET side
# reads these off the Python response and persists them on
# ``RecipeImport`` + ``ChatUsageLog`` rows so admins can see spend by
# user / model. Keep the names stable — changing them is a breaking
# contract change across both services.
_HEADER_PROMPT_TOKENS: Final[str] = "X-Extractor-Prompt-Tokens"
_HEADER_COMPLETION_TOKENS: Final[str] = "X-Extractor-Completion-Tokens"
_HEADER_CACHED_TOKENS: Final[str] = "X-Extractor-Cached-Tokens"
_HEADER_MODEL: Final[str] = "X-Extractor-Model"

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


class ExtractPhotosRequest(BaseModel):
    """Body of ``POST /extract/photos`` (P2-3).

    ``photo_urls`` arrives as a list of ``HttpUrl`` so pydantic rejects
    non-http[s] schemes at the edge (HTTP 422). The pipeline layer
    enforces the 1..10 cap + non-empty strings; we don't duplicate the
    cap in the pydantic model because the pipeline's German error
    message ("Maximal 10 Fotos pro Import.") is what the frontend
    wants to render verbatim, not a generic pydantic ValidationError.
    """

    photo_urls: list[HttpUrl] = Field(
        description=(
            "Ordered list of signed photo URLs. Order defines reading "
            "sequence for multi-page recipes — page 1 first."
        ),
    )
    hint: ExtractHint

    model_config = {"extra": "forbid"}


class ChatMessageModel(BaseModel):
    """One chat message in request bodies.

    Mirrors :class:`extractor.llm.ChatMessage` but as a pydantic model so
    FastAPI validates the role + content at the edge (422 on violations)
    before the pipeline sees anything. ``extra="forbid"`` blocks payload
    drift (e.g. clients sending function-call fields the service wouldn't
    persist anyway).
    """

    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)

    model_config = {"extra": "forbid"}


class ChatRequest(BaseModel):
    """Body of ``POST /chat``."""

    session_id: str = Field(min_length=1, max_length=200)
    messages: list[ChatMessageModel]

    model_config = {"extra": "forbid"}


class ChatResponse(BaseModel):
    """Response model for ``POST /chat``.

    Single field for now; an SSE streaming variant (v1.1) keeps this
    shape for the non-streaming path.
    """

    assistant_message: str

    model_config = {"extra": "forbid"}


class ChatToRecipeRequest(BaseModel):
    """Body of ``POST /chat/{session_id}/to-recipe``.

    ``session_id`` lives in the path — the body only carries the
    dialogue, matching the plan's API shape.
    """

    messages: list[ChatMessageModel]

    model_config = {"extra": "forbid"}


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
    """Map :class:`ExtractionError.code` → HTTP status.

    - ``source_unavailable`` (dead/private URL) → 422.
    - ``invalid_input`` (P2-3: bad photo count / bad scheme) → 422.
    - ``transcription_failed`` — Whisper model trouble → 500.
    """
    if exc.code in ("source_unavailable", "invalid_input"):
        # Caller-side mistakes — surface the German message verbatim.
        return HTTPException(status_code=422, detail=str(exc))
    # transcription_failed — model trouble. 500.
    return HTTPException(status_code=500, detail=str(exc))


def _as_chat_messages(messages: list[ChatMessageModel]) -> list[ChatMessage]:
    """Translate the wire-level pydantic list to the TypedDict shape.

    The pipeline + provider consume :class:`ChatMessage` TypedDicts;
    the pydantic models live only at the HTTP edge.
    """
    return [{"role": m.role, "content": m.content} for m in messages]


def _apply_usage_headers(response: Response, usage: TokenUsage) -> None:
    """Stamp the four ``X-Extractor-*`` PF2 headers onto ``response``.

    Takes a :class:`TokenUsage` from either the provider directly
    (chat endpoint) or from :class:`ExtractionResult.usage` (extract
    endpoints) — both carry the same shape.
    """
    response.headers[_HEADER_PROMPT_TOKENS] = str(usage["prompt_tokens"])
    response.headers[_HEADER_COMPLETION_TOKENS] = str(usage["completion_tokens"])
    response.headers[_HEADER_CACHED_TOKENS] = str(usage["cached_prompt_tokens"])
    response.headers[_HEADER_MODEL] = usage["model"]


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

    # HMAC verification middleware — skips ``/health`` so the Docker
    # HEALTHCHECK can keep polling without signing. Wires the shared
    # secret from Settings once at app construction. Tests that don't
    # want HMAC can either leave ``extractor_shared_secret`` blank
    # (middleware fails closed) or override the main app's middleware
    # stack via ``app.user_middleware``.
    settings = _get_settings()
    if settings.extractor_shared_secret:
        application.add_middleware(
            HmacVerificationMiddleware,
            shared_secret=settings.extractor_shared_secret,
        )
    else:
        logger.warning(
            "EXTRACTOR_SHARED_SECRET is empty; HMAC verification disabled. "
            "Safe for local dev / tests, NEVER for production.",
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
        response: Response,
        provider: Annotated[LLMProvider, Depends(get_llm_provider)],
        video_stack: Annotated[VideoStack | None, Depends(get_video_stack)],
    ) -> ExtractionResult:
        """Run the URL → structured-recipe pipeline.

        Translates pipeline errors to HTTP:
        - :class:`LLMProviderError` → 503 (``provider_unavailable`` /
          ``rate_limited``), 500 otherwise.
        - :class:`ExtractionError` ``source_unavailable`` → 422,
          ``transcription_failed`` → 500.

        On success the four ``X-Extractor-*`` headers carry the
        token-usage numbers for the .NET side to persist (PF2).
        """
        logger.info(
            "extract_url request group_id=%s user_id=%s",
            request.hint.group_id,
            request.hint.user_id,
        )
        downloader = video_stack.downloader if video_stack is not None else None
        transcriber = video_stack.transcriber if video_stack is not None else None
        try:
            result = await extract_from_url(
                str(request.url),
                provider=provider,
                downloader=downloader,
                transcriber=transcriber,
            )
        except LLMProviderError as exc:
            raise _http_from_llm_error(exc) from exc
        except ExtractionError as exc:
            raise _http_from_extraction_error(exc) from exc
        usage = result.get("usage")
        if usage is not None:
            _apply_usage_headers(response, usage)
        return result

    @application.post("/extract/photos", tags=["extract"])
    async def extract_photos(
        request: ExtractPhotosRequest,
        response: Response,
        provider: Annotated[LLMProvider, Depends(get_llm_provider)],
    ) -> ExtractionResult:
        """Run the photos → structured-recipe pipeline (P2-3).

        Delegates input-shape validation (http[s] scheme, list-of-URL
        shape) to pydantic, and count + empty-string validation to the
        pipeline (so the German error message from the pipeline is what
        the frontend renders).

        Error mapping:
        - :class:`ExtractionError` ``invalid_input`` → 422.
        - :class:`LLMProviderError` ``provider_unavailable`` /
          ``rate_limited`` → 503. Other codes → 500.

        On success the four ``X-Extractor-*`` headers carry the
        token-usage numbers for the .NET side to persist (PF2).
        """
        logger.info(
            "extract_photos request group_id=%s user_id=%s count=%d",
            request.hint.group_id,
            request.hint.user_id,
            len(request.photo_urls),
        )
        # ``HttpUrl`` → ``str`` round-trip: the pipeline accepts plain
        # str URLs; pydantic's HttpUrl is just the validation hop.
        urls: list[str] = [str(u) for u in request.photo_urls]
        try:
            result = await extract_from_photos(urls, provider=provider)
        except ExtractionError as exc:
            raise _http_from_extraction_error(exc) from exc
        except LLMProviderError as exc:
            raise _http_from_llm_error(exc) from exc
        usage = result.get("usage")
        if usage is not None:
            _apply_usage_headers(response, usage)
        return result

    @application.post("/chat", response_model=ChatResponse, tags=["chat"])
    async def chat_endpoint(
        request: ChatRequest,
        response: Response,
        provider: Annotated[LLMProvider, Depends(get_llm_provider)],
    ) -> ChatResponse:
        """Run one conversational turn.

        - ``EmptyMessagesError`` → 400.
        - ``MessagesTooLongError`` → 413.
        - :class:`LLMProviderError` → 503 (provider_unavailable /
          rate_limited) or 500 otherwise.

        Note: user content is *not* logged at INFO — only the turn
        count + session_id is, so the server logs don't become an
        accidental transcript archive.

        On success the four ``X-Extractor-*`` headers carry the
        token-usage numbers for the .NET side to persist (PF2).
        """
        logger.info(
            "chat request session_id=%s turns=%d",
            request.session_id,
            len(request.messages),
        )
        messages = _as_chat_messages(request.messages)
        try:
            reply, usage = await chat_turn(messages, provider)
        except EmptyMessagesError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except MessagesTooLongError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        except LLMProviderError as exc:
            raise _http_from_llm_error(exc) from exc
        _apply_usage_headers(response, usage)
        return ChatResponse(assistant_message=reply)

    @application.post("/chat/{session_id}/to-recipe", tags=["chat"])
    async def chat_to_recipe_endpoint(
        session_id: str,
        request: ChatToRecipeRequest,
        response: Response,
        provider: Annotated[LLMProvider, Depends(get_llm_provider)],
    ) -> ExtractionResult:
        """Verdichte den Dialog zu einem strukturierten Rezept.

        The path's ``session_id`` becomes the synthetic ``source_url``
        ("chat:<session_id>") on the returned recipe so the downstream
        UI has a stable reference even though the service itself is
        stateless.

        On success the four ``X-Extractor-*`` headers carry the
        token-usage numbers for the .NET side to persist (PF2).
        """
        logger.info(
            "chat_to_recipe request session_id=%s turns=%d",
            session_id,
            len(request.messages),
        )
        messages = _as_chat_messages(request.messages)
        try:
            result = await chat_to_recipe(messages, provider, session_id=session_id)
        except EmptyMessagesError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except MessagesTooLongError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        except LLMProviderError as exc:
            raise _http_from_llm_error(exc) from exc
        usage = result.get("usage")
        if usage is not None:
            _apply_usage_headers(response, usage)
        return result

    return application


# Module-level ASGI handle for uvicorn / the Docker CMD.
# `uvicorn extractor.main:app` looks this name up on import.
app: FastAPI = create_app()
