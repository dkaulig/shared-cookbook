"""FastAPI application entrypoint for the recipe extractor service.

Exposes a single endpoint at this stage:
- ``GET /health`` — cheap liveness/readiness probe consumed by the
  Docker HEALTHCHECK and (from P2-6) by the .NET orchestrator.

Business endpoints (URL extraction, photo extraction, chat) arrive in
later sub-slices — see ``docs/plans/2026-04-18-phase-2-architecture.md``.
"""

from __future__ import annotations

import logging
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as pkg_version
from typing import Final

from fastapi import FastAPI
from pydantic import BaseModel, Field

_PACKAGE_NAME: Final[str] = "extractor"

logger = logging.getLogger(__name__)


class HealthResponse(BaseModel):
    """Response model for ``GET /health``.

    Locked down with ``model_config.extra = "forbid"`` so adding a field
    without updating the contract test fails fast rather than silently
    shipping drift.
    """

    status: str = Field(description="Literal 'ok' when the service is up.")
    service: str = Field(description="Service identifier — always 'extractor' here.")
    version: str = Field(description="Package version from installed metadata.")

    model_config = {"extra": "forbid"}


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
            "Internal recipe-extraction microservice. Not exposed to end users — "
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

    return application


# Module-level ASGI handle for uvicorn / the Docker CMD.
# `uvicorn extractor.main:app` looks this name up on import.
app: FastAPI = create_app()
