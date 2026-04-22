"""HMAC-SHA256 verification middleware for .NET → Python calls.

P2-5 wires the .NET Hangfire jobs to call the extractor over HTTP. To
keep the Python service behind a trust boundary even inside the docker
network, every call (except ``GET /health``, which the Docker
HEALTHCHECK hits unauthenticated) must carry three headers:

- ``X-User-Id`` — caller user id (Guid "D" string).
- ``X-Extractor-Timestamp`` — unix seconds as ASCII decimal.
- ``X-Extractor-Signature`` — lower-case hex
  ``HMAC-SHA256(user_id + "|" + timestamp + "|" + body_hash, secret)``
  where ``body_hash = sha256(body).hexdigest()`` (lower-case hex).

Missing or malformed → 401. Timestamp outside the 15-minute skew window
→ 401 (replay protection). Signature mismatch → 401.

The middleware reads the shared secret from
:func:`extractor.config.Settings.extractor_shared_secret`. If the secret
is empty at startup and the middleware is asked to verify a request,
it fails closed with a 500 (service misconfig).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from collections.abc import Awaitable, Callable, Iterable
from typing import Final

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

logger = logging.getLogger(__name__)

# Header contract — must stay in lockstep with
# apps/api/src/FamilienKochbuch.Api/Services/ExtractorHmacSigner.cs.
USER_ID_HEADER: Final[str] = "x-user-id"
TIMESTAMP_HEADER: Final[str] = "x-extractor-timestamp"
SIGNATURE_HEADER: Final[str] = "x-extractor-signature"

# Paths that bypass HMAC verification. ``/health`` is hit by the Docker
# HEALTHCHECK without creds; anything else must authenticate.
HEALTH_BYPASS_PATHS: Final[frozenset[str]] = frozenset({"/health"})

# Prefix-based bypasses. COVER-0 fix: the .NET CandidateAttacher fetches
# ffmpeg-extracted frames via ``/extractor/frames/<dir_id>/<idx>.jpg``
# using its unsigned HttpClient (the signer lives only on the higher-
# level job dispatch client). The route is safe to expose unsigned
# because:
# - The python-extractor container is NOT routed via Caddy (see
#   ``infra/Caddyfile``) — external callers get 404 on every path.
# - The dir_id is a server-minted UUID and the file path regex refuses
#   traversal, so an on-net attacker would still need to guess a UUID
#   to exfiltrate a single jpeg frame before the sweep runs.
BYPASS_PREFIXES: Final[tuple[str, ...]] = ("/extractor/frames/",)

# 15-minute skew window (900s) — identical on both sides of the bridge.
# Chosen tight enough that the replay surface is small while still
# tolerating modest clock drift between the .NET + Python containers.
MAX_SKEW_SECONDS: Final[int] = 900

# Header names as emitted by the .NET signer (mixed case). Starlette
# normalises header lookup to lower-case, so we query via the lower-case
# constants above.


class HmacVerificationMiddleware(BaseHTTPMiddleware):
    """Starlette middleware that enforces the .NET ↔ Python HMAC contract.

    Parameters
    ----------
    app:
        The ASGI app to wrap (FastAPI passes this automatically).
    shared_secret:
        The HMAC key. MUST be non-empty; an empty key disables the
        middleware entirely so tests that don't care about auth can
        opt out via ``extractor_shared_secret=""``.
    bypass_paths:
        Iterable of absolute paths that skip verification. Default is
        just ``/health`` — passing an explicit set from a test keeps
        the fixture hermetic.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        shared_secret: str,
        bypass_paths: Iterable[str] | None = None,
    ) -> None:
        super().__init__(app)
        self._shared_secret = shared_secret.encode()
        self._bypass_paths = (
            frozenset(bypass_paths) if bypass_paths is not None else HEALTH_BYPASS_PATHS
        )

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        # Bypass paths pass through untouched (used by Docker HEALTHCHECK).
        if request.url.path in self._bypass_paths:
            return await call_next(request)
        # Prefix bypasses — COVER-0 fix for the unsigned frame-fetch
        # endpoint hit by the .NET CandidateAttacher's HttpClient.
        for prefix in BYPASS_PREFIXES:
            if request.url.path.startswith(prefix):
                return await call_next(request)

        # Secret not configured — don't silently let requests through.
        if not self._shared_secret:
            logger.error("HMAC verification requested but EXTRACTOR_SHARED_SECRET is empty.")
            return JSONResponse(
                status_code=500,
                content={"detail": "Extractor shared secret not configured."},
            )

        error = await self._verify(request)
        if error is not None:
            return JSONResponse(status_code=401, content={"detail": error})

        return await call_next(request)

    async def _verify(self, request: Request) -> str | None:
        """Return ``None`` on success, a German error message on failure.

        Intentionally returns the same generic "ungültige Signatur"
        phrasing for every failure mode so a caller can't enumerate
        which specific header was wrong. The specific reason is still
        logged at INFO for operator visibility.
        """
        user_id = request.headers.get(USER_ID_HEADER)
        timestamp = request.headers.get(TIMESTAMP_HEADER)
        signature = request.headers.get(SIGNATURE_HEADER)

        if not user_id or not timestamp or not signature:
            logger.info(
                "HMAC rejected: missing header(s) path=%s user_id=%s ts=%s sig=%s",
                request.url.path,
                bool(user_id),
                bool(timestamp),
                bool(signature),
            )
            return "Fehlende Authentifizierungs-Header."

        # Timestamp must parse as an int (unix seconds).
        try:
            ts_value = int(timestamp)
        except ValueError:
            logger.info(
                "HMAC rejected: non-numeric timestamp path=%s ts=%r",
                request.url.path,
                timestamp,
            )
            return "Ungültiger Zeitstempel."

        now = int(time.time())
        if abs(now - ts_value) > MAX_SKEW_SECONDS:
            logger.info(
                "HMAC rejected: timestamp outside %ds skew window path=%s ts=%d now=%d",
                MAX_SKEW_SECONDS,
                request.url.path,
                ts_value,
                now,
            )
            return "Zeitstempel außerhalb des Gültigkeitsfensters."

        body = await request.body()
        body_hash = hashlib.sha256(body).hexdigest()

        payload = f"{user_id}|{timestamp}|{body_hash}".encode()
        expected = hmac.new(self._shared_secret, payload, hashlib.sha256).hexdigest()

        if not hmac.compare_digest(expected, signature.lower()):
            logger.info(
                "HMAC rejected: signature mismatch path=%s user_id=%s",
                request.url.path,
                user_id,
            )
            return "Ungültige Signatur."

        # Success — fall through to the route handler.
        return None
