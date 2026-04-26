"""FastAPI application entrypoint for the recipe extractor service.

Exposes:
- ``GET /health`` — cheap liveness/readiness probe consumed by the
  Docker HEALTHCHECK and the .NET orchestrator.
- ``POST /extract/url`` — accepts a URL + caller hint, runs the full
  video/blog extraction pipeline, returns a structured recipe result.
- ``POST /extract/photos`` — accepts 1..10 signed photo URLs + caller
  hint, runs the Vision-LLM pipeline, returns the same structured
  recipe shape (P2-3).
- ``POST /chat/{session_id}/to-recipe`` — verdichte den Dialog zu
  einem strukturierten Rezept. (CR5: the former ``POST /chat`` turn
  endpoint is gone; chat turns are served natively by the .NET API
  with Azure OpenAI SSE streaming. Only the to-recipe conversion
  proxy remains here because it reuses the ExtractionResult schema
  + post-process pipeline.)

Dependencies are injected via FastAPI's ``Depends`` so tests can
override the LLM provider and the video stack (downloader +
transcriber) without touching real Azure / real yt-dlp / real Whisper.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from functools import lru_cache
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as pkg_version
from pathlib import Path
from typing import Annotated, Final, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi import Path as PathParam
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, HttpUrl, field_validator

from extractor.config import Settings
from extractor.config_loader import ExtractorConfig
from extractor.frames import FrameStore
from extractor.llm import ChatMessage, LLMProvider, LLMProviderError, TokenUsage, build_provider
from extractor.pipeline.chat import (
    EmptyMessagesError,
    MessagesTooLongError,
    chat_to_recipe,
)
from extractor.pipeline.photo import extract_from_photos
from extractor.pipeline.types import ExtractionResult
from extractor.pipeline.url import extract_from_url
from extractor.pipeline.video import (
    ExtractionError,
    FrameExtractor,
    Transcriber,
    VideoDownloader,
)
from extractor.progress import NullProgressReporter, ProgressReporter
from extractor.prompt_seed import seed_prompts
from extractor.prompts.language import SupportedLanguage, normalize_accept_language
from extractor.security import HmacVerificationMiddleware

_PACKAGE_NAME: Final[str] = "shared-cookbook-extractor"

# Response-header names for token-usage propagation. The .NET side
# reads these off the Python response and persists them on
# ``RecipeImport`` + ``ChatUsageLog`` rows so admins can see spend by
# user / model. Keep the names stable — changing them is a breaking
# contract change across both services.
_HEADER_PROMPT_TOKENS: Final[str] = "X-Extractor-Prompt-Tokens"
_HEADER_COMPLETION_TOKENS: Final[str] = "X-Extractor-Completion-Tokens"
_HEADER_CACHED_TOKENS: Final[str] = "X-Extractor-Cached-Tokens"
_HEADER_MODEL: Final[str] = "X-Extractor-Model"

# PV2 SSRF guard: only allow progress callbacks at the .NET API's
# docker-internal hostname (``api`` in docker-compose). Operators can
# override via the ``PROGRESS_CALLBACK_HOST`` env var — useful in local
# dev against a host-run .NET, or in prod where the service name
# differs. The check is cheap host-string comparison at request-parse
# time (pydantic validator on every request), backstopped by the
# runtime DNS-resolved SSRF check in ``progress._post``. See fix 1 in
# ``docs/plans/2026-04-19-video-import-progress-design.md``.
_PROGRESS_CALLBACK_HOST_DEFAULT: Final[str] = "api"

# UUID v4-ish pattern — pydantic rejects anything else at request
# parse so a malformed ``import_id`` can't slip through into logs or
# downstream HTTP callbacks where it could be interpreted as a path
# injection vector. Loose on case (accepts upper + lower).
UUID_PATTERN: Final[str] = (
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

logger = logging.getLogger(__name__)

# BUG-034 — configure root logging at module import so the pipeline's
# ``logger.info(...)`` lines (``extract_from_url signals``,
# ``caption_url_followed``, ``transcript_done``, …) actually render
# under uvicorn + Docker. Without this, the stdlib root logger stays at
# WARNING and every INFO line from our code is dropped, which makes
# "why is this import empty?" forensics impossible. ``force=True``
# because uvicorn installs its own root handler first; without force
# the config is a no-op. The format mirrors uvicorn's default shape so
# log aggregators don't see a stylistic disparity between FastAPI's
# own lines and ours.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    force=True,
)


def _callback_host_allowlist() -> str:
    """Resolve the per-request allowlist host from env.

    Read at validator time (not import time) so tests + integration
    runs can flip the env var between requests without recreating the
    app. Defaults to ``"api"`` (the docker-compose service name).
    """
    return os.environ.get("PROGRESS_CALLBACK_HOST", _PROGRESS_CALLBACK_HOST_DEFAULT).lower()


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
    service: str = Field(
        description="Service identifier - always 'shared-cookbook-extractor' here.",
    )
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


class ProgressCallbackFields(BaseModel):
    """Mixin carrying the four PV2 progress-callback fields.

    Both :class:`ExtractUrlRequest` and :class:`ExtractPhotosRequest`
    inherit this so the four fields stay in lockstep (shape,
    validation, docstrings). Extracting them fixes the earlier drift
    where only the URL request had field-level ``description`` strings
    and the photo request didn't.

    Validation contract:

    - ``callback_url`` host MUST match
      ``PROGRESS_CALLBACK_HOST`` (env override) or the ``"api"``
      default — an SSRF guard at request-parse time that refuses any
      attempt to point the callback at an attacker-chosen host
      (metadata endpoints, internal services, attacker-controlled
      public hosts). The runtime ``_post`` has a second DNS-resolved
      SSRF check as defence-in-depth.
    - ``import_id`` MUST match :data:`UUID_PATTERN` when set —
      forbids any other shape so malformed IDs can't slip into logs
      or path-concat'd callback URLs.
    - ``attempt`` is bounded 1..3 to match the .NET retry ceiling.
    """

    callback_url: HttpUrl | None = Field(
        default=None,
        description=(
            "Full URL of the .NET progress-ingest endpoint "
            "(``.../api/internal/imports/{id}/progress``) or null to "
            "disable progress callbacks."
        ),
    )
    callback_token: str | None = Field(
        default=None,
        description=(
            "Per-import HMAC-signed bearer token minted by .NET. Pairs "
            "with ``callback_url``; both must be set for callbacks to fire."
        ),
    )
    import_id: str | None = Field(
        default=None,
        pattern=UUID_PATTERN,
        description="UUID string of the originating RecipeImport — logged only.",
    )
    attempt: int = Field(
        default=1,
        ge=1,
        le=3,
        description="Retry attempt number (1..3). Stamped on every callback.",
    )

    @field_validator("callback_url")
    @classmethod
    def _validate_callback_host(cls, v: HttpUrl | None) -> HttpUrl | None:
        """Reject any host that isn't in the allowlist.

        Primary SSRF defence for the progress-callback flow — early
        reject at request parse returns HTTP 422 before the pipeline
        ever constructs a reporter. Without this, an attacker with a
        valid HMAC signature could set ``callback_url`` to
        ``http://169.254.169.254/...`` (AWS metadata) or
        ``http://attacker.evil/`` and receive the per-import bearer
        token on every callback.
        """
        if v is None:
            return v
        host = (v.host or "").lower()
        allowed = _callback_host_allowlist()
        if host != allowed:
            # Phrase the error generically — the caller already knows
            # the host they sent, and leaking the allowlist via the
            # 422 body helps an attacker tune their next probe.
            raise ValueError("callback_url host not in allowlist")
        return v


class ExtractUrlRequest(ProgressCallbackFields):
    """Body of ``POST /extract/url``.

    PV2 (video-import progress tracking) inherits the four optional
    progress-callback fields from :class:`ProgressCallbackFields`.
    They default to ``None`` / ``1`` so existing callers (tests, local
    direct-Python usage) stay backward-compatible — a missing
    ``callback_url`` means the pipeline runs with a no-op reporter.
    """

    url: HttpUrl = Field(description="Source URL — video host or blog URL.")
    hint: ExtractHint


class ExtractPhotosRequest(ProgressCallbackFields):
    """Body of ``POST /extract/photos`` (P2-3).

    ``photo_urls`` arrives as a list of ``HttpUrl`` so pydantic rejects
    non-http[s] schemes at the edge (HTTP 422). The pipeline layer
    enforces the 1..10 cap + non-empty strings; we don't duplicate the
    cap in the pydantic model because the pipeline's German error
    message ("Maximal 10 Fotos pro Import.") is what the frontend
    wants to render verbatim, not a generic pydantic ValidationError.

    PV2: inherits the four progress-callback fields from
    :class:`ProgressCallbackFields`. ``extra="forbid"`` stays intact;
    the inherited fields are part of the schema so callers sending
    them succeed while unknown keys still fail.
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
    """Bundle the video-path components so tests can override them with
    a single ``dependency_overrides`` call.

    COVER-0 slice A — ``frame_extractor`` is optional so the existing
    test rigs that only set downloader + transcriber keep working;
    when ``None``, the pipeline falls back to its lazy
    :class:`FfmpegFrameExtractor` default (writing into the video
    workdir).
    """

    downloader: VideoDownloader
    transcriber: Transcriber
    frame_extractor: FrameExtractor | None = None


@lru_cache(maxsize=1)
def _get_settings() -> Settings:
    """Singleton ``Settings`` instance."""
    return Settings()


def get_llm_provider() -> LLMProvider:
    """FastAPI dependency returning the configured LLM provider.

    Tests override this to inject a :class:`MockLLMProvider`.
    """
    return build_provider(_get_settings())


# CFG-1 — process-wide ExtractorConfig + the httpx client that backs it.
# Both singletons live for the lifetime of the FastAPI app so the 60 s
# TTL cache survives across requests (the whole point). Tests override
# :func:`get_extractor_config` via FastAPI ``dependency_overrides`` to
# inject a fake pre-seeded config.
_extractor_config_client: httpx.AsyncClient | None = None
_extractor_config_singleton: ExtractorConfig | None = None


def get_extractor_config() -> ExtractorConfig | None:
    """FastAPI dependency returning the :class:`ExtractorConfig` singleton.

    Returns ``None`` when ``extractor_config_api_base`` is empty — that
    signals "don't fetch, just use defaults" for hermetic test + local
    hacking runs without the .NET side.
    """
    global _extractor_config_singleton, _extractor_config_client
    if _extractor_config_singleton is not None:
        return _extractor_config_singleton
    settings = _get_settings()
    base = settings.extractor_config_api_base.strip()
    if not base:
        logger.info(
            "ExtractorConfig disabled (EXTRACTOR_CONFIG_API_BASE empty) —"
            " pipeline uses hardcoded defaults."
        )
        return None
    _extractor_config_client = httpx.AsyncClient(base_url=base)
    _extractor_config_singleton = ExtractorConfig(
        client=_extractor_config_client,
        ttl_seconds=settings.extractor_config_ttl_seconds,
    )
    return _extractor_config_singleton


# COVER-0 fix: process-wide FrameStore singleton. Built lazily from
# Settings so the env var can point at a different root in tests /
# container overrides without rebuilding the app. The store owns only a
# filesystem path + the regex gates — no open handles — so sharing
# across requests is safe.
_frame_store_singleton: FrameStore | None = None


def get_frame_store() -> FrameStore:
    """FastAPI dependency returning the :class:`FrameStore` singleton.

    Tests override via ``app.dependency_overrides`` to point the store
    at a tmp dir; production reads the base path + url prefix from
    :class:`Settings.extractor_frames_dir` +
    :class:`Settings.extractor_frames_url_base`.
    """
    global _frame_store_singleton
    if _frame_store_singleton is None:
        settings = _get_settings()
        _frame_store_singleton = FrameStore(
            root=Path(settings.extractor_frames_dir),
            url_base=settings.extractor_frames_url_base,
        )
    return _frame_store_singleton


def get_user_language(
    accept_language: Annotated[str | None, Header(alias="Accept-Language")] = None,
) -> SupportedLanguage:
    """FastAPI dependency that returns the caller's UI language.

    LANG-1 — reads the inbound ``Accept-Language`` header (forwarded
    verbatim by the .NET API from the browser's axios interceptor) and
    normalises it to one of the two whitelisted languages
    (:data:`SupportedLanguage`). Missing / garbage / unsupported headers
    fall back to ``"en"`` — matches REL-3h on the web side.

    Tests override via ``app.dependency_overrides`` to pin a language
    without round-tripping through the header parser.
    """
    return normalize_accept_language(accept_language)


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
    if code == "ai_disabled":
        # REL-7 — operator set LLM_PROVIDER=disabled intentionally. The
        # frontend's feature-gate normally hides these endpoints, but a
        # direct / stale-client call still reaches here; respond with a
        # clean 503 so the web layer can render a user-visible German
        # message instead of the generic 500 "unknown error" fallback.
        return HTTPException(
            status_code=503,
            detail=(
                "KI-Funktionen sind auf dieser Instanz deaktiviert. "
                "Admin muss LLM_PROVIDER in .env auf azure oder ollama setzen."
            ),
        )
    if code == "not_configured":
        # Service misconfig: admin-facing. Log at ERROR and hide the
        # internal message from the caller.
        logger.error("LLM provider not configured: %s", exc)
        return HTTPException(status_code=500, detail="KI-Service ist nicht konfiguriert.")
    if code == "truncated_response":
        # Azure capped output mid-string (status: "incomplete" +
        # incomplete_details.reason: "max_output_tokens"). The body is
        # JSON-broken; a generic 500 hides the real cause from the user.
        # 422 because the failure is shaped by the user's input (the
        # source video / recipe is too complex for the current cap), not
        # an internal bug. The ``truncated_response:`` prefix is part of
        # the wire contract so the FE can substring-match the code on
        # the persisted ``RecipeImport.ErrorMessage`` and render a
        # friendlier message even on legacy rows. Operator action when
        # the error becomes common: bump
        # ``llm.structured.max_completion_tokens``.
        logger.warning("LLM provider error code=%s msg=%s", code, exc)
        return HTTPException(
            status_code=422,
            detail=(
                "truncated_response: Antwort zu lang — das Video oder Rezept "
                "ist sehr komplex. Versuche eine kürzere Quelle oder eine "
                "direkte Rezept-URL."
            ),
        )
    # auth_failure / invalid_request / schema_mismatch — all service bugs
    # from the caller's perspective. Generic 500 + log.
    logger.error("LLM provider error code=%s msg=%s", code, exc)
    return HTTPException(status_code=500, detail="Interner Fehler bei der KI-Verarbeitung.")


def _http_from_extraction_error(exc: ExtractionError) -> HTTPException:
    """Map :class:`ExtractionError.code` → HTTP status.

    - ``source_unavailable`` (dead/private URL) → 422.
    - ``invalid_input`` (P2-3: bad photo count / bad scheme) → 422.
    - ``feature_disabled`` (CFG-1 kill switch) → 422 with the German
      message the pipeline emitted verbatim.
    - ``transcription_failed`` — Whisper model trouble → 500.
    """
    if exc.code in ("source_unavailable", "invalid_input", "feature_disabled"):
        # Caller-side mistakes OR admin-disabled features — surface the
        # German message verbatim so the frontend can render it.
        return HTTPException(status_code=422, detail=str(exc))
    # transcription_failed — model trouble. 500.
    return HTTPException(status_code=500, detail=str(exc))


def _as_chat_messages(messages: list[ChatMessageModel]) -> list[ChatMessage]:
    """Translate the wire-level pydantic list to the TypedDict shape.

    The pipeline + provider consume :class:`ChatMessage` TypedDicts;
    the pydantic models live only at the HTTP edge.
    """
    return [{"role": m.role, "content": m.content} for m in messages]


def _build_reporter(
    *,
    callback_url: HttpUrl | None,
    callback_token: str | None,
    import_id: str | None,
    attempt: int,
) -> ProgressReporter:
    """Construct a :class:`ProgressReporter` from the request fields.

    Returns a :class:`NullProgressReporter` when ``callback_url`` or
    ``callback_token`` is missing — the pipeline then incurs zero HTTP
    traffic, preserving backward-compat with tests + local direct-
    Python usage.
    """
    if callback_url is None or callback_token is None:
        return NullProgressReporter()
    return ProgressReporter(
        callback_url=str(callback_url),
        callback_token=callback_token,
        attempt=attempt,
        import_id=import_id,
    )


def _apply_usage_headers(response: Response, usage: TokenUsage) -> None:
    """Stamp the four ``X-Extractor-*`` usage headers onto ``response``.

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


async def _prefetch_whisper_model() -> None:
    """Resolve the faster-whisper weights into the HF cache off the hot path.

    Runs in a thread (the constructor is blocking + CPU-bound on the
    CTranslate2 load) so uvicorn's event loop stays free while the
    ~3 GB download streams in on first container boot. Failures log a
    warning and are swallowed — the first real transcription call will
    re-attempt the download at that point. This only exists to keep the
    first-user-facing request from blocking on HuggingFace.

    Skipped under pytest: CI runners have no HF cache, so each
    ``with TestClient(app)`` would kick off a 3 GB download that still
    runs when the context exits — shutdown then blocks on task.cancel()
    + await task, compounding across tests into a multi-minute hang.

    REL-7 — also skipped when ``AI_ENABLED=false``. The design-doc's
    "Runs-without-AI" inventory lists Whisper as a local-compute
    dependency (not AI strictly), but Video-URL imports only make sense
    with AI available (either LLM-structuring or raw-text pre-fill;
    the second path still needs the 3 GB Whisper weights). Skipping the
    prefetch saves the download on the Path-1 minimal install the
    design doc explicitly optimises for.
    """
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    if not _get_settings().ai_enabled:
        logger.info("whisper prefetch skipped: AI_ENABLED=false — no video imports supported.")
        return
    try:
        from extractor.pipeline.video import FasterWhisperTranscriber
    except ImportError:  # pragma: no cover — faster-whisper optional at dev-time
        logger.warning("whisper prefetch skipped: faster-whisper import failed")
        return
    logger.info("whisper prefetch started")
    try:
        await asyncio.to_thread(FasterWhisperTranscriber)
    except Exception as exc:
        logger.warning("whisper prefetch failed (will retry on first transcribe): %s", exc)
        return
    logger.info("whisper prefetch completed")


async def _seed_prompts_at_startup() -> None:
    """CFG-1b — one-shot POST of the three real DE prompts to the .NET
    seed endpoint.

    Honours :attr:`Settings.extractor_prompt_seed_enabled` (default on)
    so a local dev run with intentionally-placeholder DB rows can opt
    out via the env var. Skipped under pytest: integration tests own
    their own DB and don't need a live POST; the dedicated
    :mod:`tests.test_prompt_seed` exercises the module directly.

    Reuses the same httpx client the :class:`ExtractorConfig` loader
    uses (or builds a transient one if the loader is disabled) so we
    pay one TCP/TLS handshake instead of two.
    """
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    settings = _get_settings()
    if not settings.extractor_prompt_seed_enabled:
        logger.info("prompt_seed skipped: EXTRACTOR_PROMPT_SEED_ENABLED=false")
        return
    base = settings.extractor_config_api_base.strip()
    if not base:
        logger.info("prompt_seed skipped: EXTRACTOR_CONFIG_API_BASE empty — no .NET API to seed.")
        return
    # Make sure the loader's singleton client is built so we share the
    # connection pool. ``get_extractor_config`` is idempotent.
    get_extractor_config()
    client = _extractor_config_client
    if client is None:
        # Fallback: loader is disabled but we still want to seed. Build
        # a transient client just for this call.
        async with httpx.AsyncClient(base_url=base) as transient:
            await seed_prompts(transient)
        return
    await seed_prompts(client)


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """FastAPI lifespan: kick off the Whisper model prefetch + the
    CFG-1b prompt seed.

    Both run as fire-and-forget background tasks — startup never blocks
    on them. The task references are stashed on the app state so
    garbage collection can't reap them mid-flight; tasks are cancelled
    cleanly on shutdown if they haven't finished yet.
    """
    whisper_task = asyncio.create_task(_prefetch_whisper_model(), name="whisper-prefetch")
    _app.state.whisper_prefetch_task = whisper_task
    seed_task = asyncio.create_task(_seed_prompts_at_startup(), name="prompt-seed")
    _app.state.prompt_seed_task = seed_task
    try:
        yield
    finally:
        for task in (whisper_task, seed_task):
            if not task.done():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task


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
        lifespan=_lifespan,
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

    @application.get(
        "/extractor/frames/{dir_id}/{filename}",
        tags=["frames"],
        response_class=FileResponse,
    )
    def serve_frame(
        store: Annotated[FrameStore, Depends(get_frame_store)],
        dir_id: Annotated[
            str,
            PathParam(
                # Repeated here rather than imported from extractor.frames
                # to keep the pydantic path-validation gate at the HTTP
                # edge. A non-UUID dir_id is refused with 422 before the
                # handler runs.
                pattern=(
                    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
                ),
            ),
        ],
        filename: Annotated[str, PathParam(pattern=r"^\d+\.jpg$")],
    ) -> FileResponse:
        """Serve an ffmpeg-extracted video frame by UUID + filename.

        COVER-0 fix: previously the pipeline emitted ``file://`` URIs
        for these frames, which the .NET CandidateAttacher couldn't
        fetch. This endpoint lets the .NET side pull frames over HTTP
        the same way it pulls CDN thumbnails.

        Unauthenticated — the python-extractor container is not routed
        via Caddy, so this endpoint is reachable only from other
        containers on the internal docker network.

        Returns 404 when the dir_id / filename combination doesn't
        resolve to a file on disk. Pydantic rejects malformed path
        components (non-UUID dir_id, non-``<digits>.jpg`` filename)
        with 422 before the handler executes.
        """
        resolved = store.resolve(dir_id, filename)
        if resolved is None:
            raise HTTPException(status_code=404, detail="Frame nicht gefunden.")
        return FileResponse(resolved, media_type="image/jpeg")

    @application.post("/extract/url", tags=["extract"])
    async def extract_url(
        request: ExtractUrlRequest,
        response: Response,
        provider: Annotated[LLMProvider, Depends(get_llm_provider)],
        video_stack: Annotated[VideoStack | None, Depends(get_video_stack)],
        config: Annotated[ExtractorConfig | None, Depends(get_extractor_config)],
        frame_store: Annotated[FrameStore, Depends(get_frame_store)],
        lang: Annotated[SupportedLanguage, Depends(get_user_language)],
    ) -> ExtractionResult:
        """Run the URL → structured-recipe pipeline.

        Translates pipeline errors to HTTP:
        - :class:`LLMProviderError` → 503 (``provider_unavailable`` /
          ``rate_limited``), 500 otherwise.
        - :class:`ExtractionError` ``source_unavailable`` → 422,
          ``transcription_failed`` → 500.

        On success the four ``X-Extractor-*`` headers carry the
        token-usage numbers for the .NET side to persist.
        """
        logger.info(
            "extract_url request group_id=%s user_id=%s import_id=%s attempt=%d",
            request.hint.group_id,
            request.hint.user_id,
            request.import_id,
            request.attempt,
        )
        downloader = video_stack.downloader if video_stack is not None else None
        transcriber = video_stack.transcriber if video_stack is not None else None
        frame_extractor = video_stack.frame_extractor if video_stack is not None else None
        reporter = _build_reporter(
            callback_url=request.callback_url,
            callback_token=request.callback_token,
            import_id=request.import_id,
            attempt=request.attempt,
        )
        try:
            try:
                result = await extract_from_url(
                    str(request.url),
                    provider=provider,
                    downloader=downloader,
                    transcriber=transcriber,
                    frame_extractor=frame_extractor,
                    frame_store=frame_store,
                    reporter=reporter,
                    config=config,
                    lang=lang,
                )
            except LLMProviderError as exc:
                raise _http_from_llm_error(exc) from exc
            except ExtractionError as exc:
                raise _http_from_extraction_error(exc) from exc
        finally:
            # Reporter owns an httpx.AsyncClient for this request
            # lifetime — close it here so the pool + TLS state is
            # released deterministically regardless of success/failure.
            await reporter.aclose()
        usage = result.get("usage")
        if usage is not None:
            _apply_usage_headers(response, usage)
        return result

    @application.post("/extract/photos", tags=["extract"])
    async def extract_photos(
        request: ExtractPhotosRequest,
        response: Response,
        provider: Annotated[LLMProvider, Depends(get_llm_provider)],
        config: Annotated[ExtractorConfig | None, Depends(get_extractor_config)],
        lang: Annotated[SupportedLanguage, Depends(get_user_language)],
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
        token-usage numbers for the .NET side to persist.
        """
        logger.info(
            "extract_photos request group_id=%s user_id=%s count=%d import_id=%s attempt=%d",
            request.hint.group_id,
            request.hint.user_id,
            len(request.photo_urls),
            request.import_id,
            request.attempt,
        )
        # ``HttpUrl`` → ``str`` round-trip: the pipeline accepts plain
        # str URLs; pydantic's HttpUrl is just the validation hop.
        urls: list[str] = [str(u) for u in request.photo_urls]
        reporter = _build_reporter(
            callback_url=request.callback_url,
            callback_token=request.callback_token,
            import_id=request.import_id,
            attempt=request.attempt,
        )
        try:
            try:
                result = await extract_from_photos(
                    urls,
                    provider=provider,
                    reporter=reporter,
                    config=config,
                    lang=lang,
                )
            except ExtractionError as exc:
                raise _http_from_extraction_error(exc) from exc
            except LLMProviderError as exc:
                raise _http_from_llm_error(exc) from exc
        finally:
            # Deterministic teardown of the reporter's httpx client.
            await reporter.aclose()
        usage = result.get("usage")
        if usage is not None:
            _apply_usage_headers(response, usage)
        return result

    @application.post("/chat/{session_id}/to-recipe", tags=["chat"])
    async def chat_to_recipe_endpoint(
        session_id: str,
        request: ChatToRecipeRequest,
        response: Response,
        provider: Annotated[LLMProvider, Depends(get_llm_provider)],
        config: Annotated[ExtractorConfig | None, Depends(get_extractor_config)],
        lang: Annotated[SupportedLanguage, Depends(get_user_language)],
    ) -> ExtractionResult:
        """Compress the dialog into a structured recipe.

        The path's ``session_id`` becomes the synthetic ``source_url``
        ("chat:<session_id>") on the returned recipe so the downstream
        UI has a stable reference even though the service itself is
        stateless.

        On success the four ``X-Extractor-*`` headers carry the
        token-usage numbers for the .NET side to persist.
        """
        logger.info(
            "chat_to_recipe request session_id=%s turns=%d",
            session_id,
            len(request.messages),
        )
        messages = _as_chat_messages(request.messages)
        try:
            result = await chat_to_recipe(
                messages, provider, session_id=session_id, config=config, lang=lang
            )
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
