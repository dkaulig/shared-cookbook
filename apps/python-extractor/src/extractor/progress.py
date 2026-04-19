"""Progress-reporter streaming throttled HMAC-auth'd callbacks to .NET.

This module provides :class:`ProgressReporter` — a fire-and-forget
HTTP callback helper used by the extraction pipeline (url + photo
paths) to push phase/progress updates to the .NET API's internal
progress-ingest endpoint (``POST /api/internal/imports/{id}/progress``).

Design constraints (see ``docs/plans/2026-04-19-video-import-progress-design.md``):

- **Fire-and-forget**: every network error is logged and swallowed.
  Callback outages MUST NOT abort extraction. The pipeline's happy
  path is the user's result; progress is a UX nicety on top.
- **Throttled**: max one POST per :data:`_THROTTLE_MS` ms within the
  same phase. Phase transitions flush immediately so the UI sees the
  stepper advance without a stall. End-of-phase events may pass
  ``force=True`` to :meth:`ProgressReporter.report` to bypass the
  throttle (e.g. the photo pipeline's 95% "vision done" tick).
- **No-op without callback_url**: local direct-Python usage and the
  existing 280-test suite pass :class:`NullProgressReporter` (or omit
  the reporter entirely) and incur zero HTTP traffic.
- **SSRF-hardened**: the runtime ``_post`` resolves the callback host
  via :func:`_assert_safe_http_target` before each request so an
  attacker who somehow bypasses the request-parse allowlist still
  can't steer the callback at a metadata endpoint or internal
  service. The allowlist at request-parse time is the primary
  defence; this is defence-in-depth.
- **Single httpx client per reporter lifetime**: connection pooling +
  TLS reuse matter once we fire >1 callback per import. The endpoint
  handlers in ``main.py`` call :meth:`ProgressReporter.aclose` after
  pipeline completion via ``try/finally``.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Final

import httpx

logger = logging.getLogger("extractor.progress")

_THROTTLE_MS: Final[int] = 500
"""Minimum milliseconds between successive POSTs within the same phase.

Phase transitions bypass this throttle (immediate flush) so the UI's
stepper advances without waiting out the interval.
"""

_TIMEOUT_S: Final[float] = 2.0
"""httpx client timeout — callbacks are best-effort; 2 s is plenty for
a local-network POST, short enough that a stuck .NET side doesn't
stall the extraction worker."""


@dataclass(frozen=True, slots=True)
class ProgressEvent:
    """A single progress snapshot queued for POST.

    All fields except ``phase`` and ``phase_progress`` are optional —
    they're omitted from the wire payload when ``None`` so the .NET
    side sees a minimal body per phase.
    """

    phase: str
    """One of ``downloading`` / ``transcribing`` / ``structuring`` /
    ``post_processing`` / ``vision_analysis``. Must match the .NET
    ``RecipeImportPhase`` string coercion exactly."""

    phase_progress: int
    """0-100 within-phase. The .NET side combines this with a phase
    weight to derive overall progress."""

    bytes_done: int | None = None
    """Downloaded byte count (video phase). ``None`` outside video."""

    bytes_total: int | None = None
    """Expected total byte count. ``None`` when yt-dlp doesn't surface
    a total (live streams, some hosts)."""

    segments_done: int | None = None
    """Transcribed segment count (transcribe phase). ``None`` outside
    transcribing."""

    segments_total: int | None = None
    """Expected total segment count. ``None`` when the transcriber
    iterates lazily and total is unknown — see
    :class:`FasterWhisperTranscriber.transcribe` for the strategy."""


class ProgressReporter:
    """Streams throttled HMAC-auth'd progress callbacks to the .NET API.

    Parameters
    ----------
    callback_url
        Full URL of the .NET progress-ingest endpoint
        (``.../api/internal/imports/{id}/progress``) or ``None`` for a
        no-op reporter. When ``None``, every :meth:`report` call
        silently returns without any HTTP traffic.
    callback_token
        Per-import HMAC-signed bearer token minted by the .NET side.
        ``None`` → no-op (same as missing ``callback_url``).
    attempt
        Current retry attempt number (1..3). Stamped into every payload
        so the .NET side can reject stale-attempt callbacks from a
        retried import.
    import_id
        Optional UUID string for log correlation. Never sent in the
        body (the .NET side derives it from the URL path).

    Notes
    -----
    This class is intentionally *not* thread-safe — it's used from a
    single asyncio task per import. Two concurrent imports should
    construct two reporters; sharing a single instance across tasks
    would race on the throttle state.

    Callers MUST invoke :meth:`aclose` at end-of-pipeline (typically via
    a ``try/finally`` in the endpoint handler) so the underlying
    :class:`httpx.AsyncClient` pool shuts down cleanly. Forgetting is
    not catastrophic (Python's async-cleanup guards prevent a hard
    leak) but it prints an asyncio-level warning in test logs.
    """

    def __init__(
        self,
        callback_url: str | None,
        callback_token: str | None,
        attempt: int,
        *,
        import_id: str | None = None,
    ) -> None:
        self._url = callback_url
        self._token = callback_token
        self._attempt = attempt
        self._import_id = import_id
        self._last_sent_at_ms: float = 0.0
        self._last_phase: str | None = None
        # Lazy-created so a NullProgressReporter never constructs an
        # AsyncClient — constructor-time was wasteful for the no-op
        # path. Populated on first ``_post`` call.
        self._client: httpx.AsyncClient | None = None

    async def report(self, event: ProgressEvent, *, force: bool = False) -> None:
        """Send the event if throttle permits, else silently drop.

        Phase transitions (``event.phase != self._last_phase``)
        bypass the throttle — the UI's phase-stepper advances
        immediately so users see the step change without a stall.

        ``force=True`` also bypasses the throttle. Use it for
        end-of-phase "final tick" events that the UI must always see
        (e.g. the photo pipeline fires a 95% ``vision_analysis`` event
        right before transitioning to ``post_processing``; without
        ``force=True`` a <500 ms-apart fire would be dropped).
        """
        if not self._url or not self._token:
            return  # no-op mode

        now_ms = time.monotonic() * 1000.0
        is_phase_change = event.phase != self._last_phase
        since_last_ms = now_ms - self._last_sent_at_ms

        if not force and not is_phase_change and since_last_ms < _THROTTLE_MS:
            return  # throttled — quietly drop this intra-phase tick

        self._last_phase = event.phase
        self._last_sent_at_ms = now_ms
        await self._post(event)

    async def flush(self) -> None:
        """No-op placeholder for future batched sends.

        Kept in the public API so callers can ``await reporter.flush()``
        at end-of-pipeline without caring whether the reporter actually
        batches internally. Today every :meth:`report` POSTs eagerly,
        so there's nothing to flush.
        """
        return

    async def aclose(self) -> None:
        """Release the underlying :class:`httpx.AsyncClient` pool.

        Safe to call multiple times; after the first call the reporter
        lazy-creates a fresh client on the next :meth:`report`, which
        keeps test helpers (e.g. ``_CapturingReporter``) that never
        instantiate a real client working.
        """
        if self._client is not None:
            try:
                await self._client.aclose()
            except httpx.HTTPError as exc:
                # ``AsyncClient.aclose`` swallows most errors
                # internally; a remaining httpx.HTTPError here means
                # an in-flight request was aborted mid-stream. Log +
                # move on — never raise into the pipeline shutdown
                # path.
                logger.warning(
                    "progress callback aclose failed import_id=%s error=%s",
                    self._import_id,
                    type(exc).__name__,
                )
            finally:
                self._client = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Return the lazy-created :class:`httpx.AsyncClient` for this reporter.

        Single client per reporter lifetime: enables connection pooling
        + TLS reuse across the ~4 callbacks a typical import fires
        (phase starts for downloading / transcribing / structuring /
        post_processing, plus per-tick throttled updates).
        """
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=_TIMEOUT_S)
        return self._client

    async def _post(self, event: ProgressEvent) -> None:
        """Build the body + POST. All network errors are swallowed.

        Applies :func:`_assert_safe_http_target` as a defence-in-depth
        SSRF guard on every call — primary defence is the pydantic
        allowlist at request-parse time, but a misconfigured
        ``PROGRESS_CALLBACK_HOST`` env var (say, pointing at a host
        whose DNS records later flip to a private IP) would otherwise
        slip through.

        This method is the only place httpx is touched; subclasses
        (:class:`NullProgressReporter`) override it to a no-op.
        """
        body: dict[str, Any] = {
            "phase": event.phase,
            "phase_progress": event.phase_progress,
            "attempt": self._attempt,
        }
        if event.bytes_done is not None:
            body["bytes_done"] = event.bytes_done
        if event.bytes_total is not None:
            body["bytes_total"] = event.bytes_total
        if event.segments_done is not None:
            body["segments_done"] = event.segments_done
        if event.segments_total is not None:
            body["segments_total"] = event.segments_total

        # self._url / self._token are guaranteed non-None when report()
        # is the caller (it early-returns in no-op mode). _post() is
        # only called as an internal override hook or via report().
        url = self._url
        token = self._token
        if url is None or token is None:
            return

        # Defence-in-depth SSRF check — import lazily so we don't
        # create a hard dep-cycle with ``pipeline.url`` at module
        # import time.
        from extractor.pipeline.url import SsrfBlockedError, _assert_safe_http_target

        try:
            await _assert_safe_http_target(url)
        except SsrfBlockedError as exc:
            # Never include the URL itself — the host name alone can
            # be an attacker-chosen SSRF reconnaissance signal.
            logger.warning(
                "progress callback blocked by ssrf guard import_id=%s phase=%s error=%s",
                self._import_id,
                event.phase,
                type(exc).__name__,
            )
            return

        try:
            client = await self._get_client()
            resp = await client.post(
                url,
                json=body,
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code >= 500:
                logger.warning(
                    "progress callback server-error import_id=%s phase=%s status=%s",
                    self._import_id,
                    event.phase,
                    resp.status_code,
                )
            elif resp.status_code >= 400:
                # 401 = bad token, 422 = invalid phase, 404 = unknown
                # importId, 429 = rate-limit. All loggable but not fatal.
                logger.warning(
                    "progress callback client-error import_id=%s phase=%s status=%s",
                    self._import_id,
                    event.phase,
                    resp.status_code,
                )
        except (httpx.HTTPError, TimeoutError) as exc:
            # Intentionally narrow catches — NEVER raise into the
            # pipeline. Callback outages degrade UX, not correctness.
            # Log only the exception *type* + a truncated message —
            # exposing ``exc`` verbatim leaks the callback URL (and via
            # it, attacker-chosen internal hostnames as SSRF
            # reconnaissance).
            logger.warning(
                "progress callback failed import_id=%s phase=%s error=%s detail=%s",
                self._import_id,
                event.phase,
                type(exc).__name__,
                str(exc)[:80],
            )


class NullProgressReporter(ProgressReporter):
    """Explicit no-op reporter for tests + direct-Python usage.

    Overrides :meth:`report` so ``report()`` never calls ``_post``; no
    HTTP attempt is ever made. (The parent's ``_post`` would return
    early anyway — ``self._url`` is ``None`` — but overriding
    ``report`` keeps the hot path allocation-free.)
    """

    def __init__(self) -> None:
        super().__init__(callback_url=None, callback_token=None, attempt=1)

    async def report(self, event: ProgressEvent, *, force: bool = False) -> None:
        return


__all__ = [
    "NullProgressReporter",
    "ProgressEvent",
    "ProgressReporter",
]
