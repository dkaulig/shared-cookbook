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

import asyncio
import contextlib
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

_HEARTBEAT_INTERVAL_S: Final[float] = 2.0
"""Seconds between heartbeat ticks emitted by
:meth:`ProgressReporter.start_heartbeat`. Matches the .NET-side
``StaleBanner`` 30 s idle threshold with comfortable headroom — even if
several heartbeats are dropped (callback failures), the banner does not
fire spuriously."""

# Phases where the heartbeat fills the progress gap with an elapsed-
# time ramp. Download / transcribe / structure can have long silent
# stretches where the underlying tool emits no progress; the ramp
# ensures the UI sees visible motion. Phases NOT in this set
# (queued, post_processing, vision_analysis, done, error) are driven
# by explicit report() calls and don't need a ramp.
_RAMP_PHASES: Final[frozenset[str]] = frozenset(
    {
        "downloading",
        "transcribing",
        "structuring",
    }
)
"""Phases where the heartbeat applies the elapsed-time ramp (BUG-031).

The ramp lives here — not in the yt-dlp progress wrapper — because
silent single-blob downloads (short FB reels) never trigger the
wrapper's hook, leaving the UI stuck at 0 %. The heartbeat's 2 s timer
is the only layer that ticks reliably regardless of what the
underlying tool does."""

_RAMP_RATE_PERCENT_PER_S: Final[float] = 3.0
"""Seconds per percentage point in the heartbeat ramp.

1/3 of a second per percent ⇒ ~3 %/s ⇒ reaches the 95 % cap at 31.7 s.
Matches the BUG-027 heuristic that already worked for HLS-fragmented
downloads — we only moved the calculation into the heartbeat layer."""

_RAMP_MAX_PERCENT: Final[int] = 95
"""Upper bound for the ramp.

The phase can only actually "complete" via an explicit phase
transition (``start_heartbeat`` with a new phase OR an explicit
``report()`` at 100), never via the ramp — 95 is the visible "almost
there" ceiling."""


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
        # Tracks the most recent intra-phase percent so the heartbeat
        # can re-emit it without stomping real progress (see
        # :meth:`start_heartbeat`). Updated on every non-heartbeat
        # ``report()`` call.
        self._last_phase_progress: int = 0
        # Active heartbeat task, if any. ``None`` when no phase is
        # currently being heartbeated. Tolerates start/stop sequences
        # across multiple phases (downloading → transcribing →
        # structuring) within a single import.
        self._heartbeat_task: asyncio.Task[None] | None = None
        # Monotonic timestamp at which :meth:`start_heartbeat` was last
        # called. The :meth:`_heartbeat_loop` uses this as the anchor
        # for the elapsed-time ramp (BUG-031). ``0.0`` until the first
        # heartbeat starts — the ramp never fires before that because
        # :meth:`_heartbeat_loop` itself is the only reader.
        self._phase_start_monotonic: float = 0.0
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
        ``force=True`` a <500 ms-apart fire would be dropped). The
        heartbeat loop (BUG-027) also uses ``force=True`` to refresh
        the .NET ``last_progress_at`` without overwriting real
        progress — it re-emits the most recent ``phase_progress``.
        """
        # Always remember the latest phase_progress so the heartbeat
        # has a value to re-emit. This is independent of throttling /
        # no-op mode: even a NullProgressReporter caller may want to
        # observe the field for tests.
        self._last_phase_progress = event.phase_progress

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

    async def start_heartbeat(self, phase: str) -> asyncio.Task[None]:
        """Spawn a background task that re-emits the last known progress
        every :data:`_HEARTBEAT_INTERVAL_S` seconds (BUG-027).

        Why this exists: video downloads from fragmented HLS sources
        (Facebook / Instagram / TikTok) may run for 30-90 s without
        yt-dlp surfacing a meaningful progress tick. Without periodic
        callbacks the .NET ``last_progress_at`` field stagnates and
        the frontend's ``StaleBanner`` fires at the 30 s threshold,
        falsely warning the user that the import is stuck. The
        heartbeat re-POSTs the most recent state with ``force=True``
        so the throttle does not swallow it — the .NET handler updates
        ``last_progress_at`` even though the percentage hasn't moved.

        Idempotency: if a heartbeat is already running for any phase,
        it is cancelled first. Callers transitioning between phases
        (downloading → transcribing → structuring) should call
        :meth:`start_heartbeat` again with the new phase name; the
        previous task is replaced.

        Returns the :class:`asyncio.Task` so callers can also cancel
        it directly if they need to.

        Snapshots the monotonic clock as the ramp anchor (BUG-031).
        Does NOT reset :attr:`_last_phase_progress` — callers already
        emit an explicit ``report(phase, 0)`` before each phase
        transition (see ``pipeline/url.py``), so the previous phase's
        percentage is flushed naturally. Resetting here would also
        break the invariant "a real progress report made before
        start_heartbeat must survive the first heartbeat tick".
        """
        await self.stop_heartbeat()
        self._phase_start_monotonic = time.monotonic()
        task = asyncio.create_task(self._heartbeat_loop(phase))
        self._heartbeat_task = task
        return task

    async def stop_heartbeat(self) -> None:
        """Cancel the active heartbeat task (if any) and await its exit.

        Safe to call multiple times; safe to call even when no
        heartbeat was ever started. Any :class:`asyncio.CancelledError`
        raised by the loop on shutdown is consumed here so the caller
        does not have to wrap the call in its own ``try`` block.
        """
        task = self._heartbeat_task
        if task is None:
            return
        self._heartbeat_task = None
        task.cancel()
        # Expected on graceful shutdown — swallow so callers (typically
        # a try/finally in the pipeline endpoint) don't have to
        # special-case this.
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def _heartbeat_loop(self, phase: str) -> None:
        """Internal loop body — re-emit the last phase_progress every tick.

        Wakes every :data:`_HEARTBEAT_INTERVAL_S` seconds. On each
        wake-up calls :meth:`report` with ``force=True`` so the
        throttle does not swallow the heartbeat. Network failures
        inside ``report`` are already swallowed at the ``_post``
        layer; any leftover :class:`httpx.HTTPError` that bubbles up
        is logged at DEBUG (heartbeats are noisy by design and a
        single failure is meaningless).

        BUG-031 — elapsed-time ramp. For phases in :data:`_RAMP_PHASES`
        the loop computes a synthetic ``ramped`` percentage from the
        monotonic time since :meth:`start_heartbeat`, capped at
        :data:`_RAMP_MAX_PERCENT`, and emits
        ``max(self._last_phase_progress, ramped)``. That keeps real
        yt-dlp / Whisper progress authoritative whenever it exceeds the
        ramp, while ensuring the UI never sees "stuck at 5 %" on silent
        single-blob downloads.
        """
        while True:
            try:
                await asyncio.sleep(_HEARTBEAT_INTERVAL_S)
                effective = self._last_phase_progress
                if phase in _RAMP_PHASES:
                    elapsed = max(0.0, time.monotonic() - self._phase_start_monotonic)
                    ramped = min(
                        _RAMP_MAX_PERCENT,
                        int(elapsed * _RAMP_RATE_PERCENT_PER_S),
                    )
                    effective = max(effective, ramped)
                await self.report(
                    ProgressEvent(phase=phase, phase_progress=effective),
                    force=True,
                )
            except asyncio.CancelledError:
                # Cooperative shutdown — re-raise so :meth:`stop_heartbeat`
                # sees the task as cancelled.
                raise
            except httpx.HTTPError as exc:
                # _post already catches httpx errors; this branch only
                # runs if a future refactor re-raises. Either way the
                # heartbeat must keep ticking. DEBUG only — a flaky
                # callback over a 60 s download would otherwise spam
                # 30 WARN lines.
                logger.debug(
                    "progress heartbeat tick failed import_id=%s phase=%s error=%s",
                    self._import_id,
                    phase,
                    type(exc).__name__,
                )

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

        Also stops any active heartbeat task — pipeline shutdown
        paths usually call ``stop_heartbeat`` explicitly inside a
        ``try/finally``, but doing it again here is cheap and prevents
        an orphaned task on direct ``aclose`` calls (tests).
        """
        await self.stop_heartbeat()
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

    async def start_heartbeat(self, phase: str) -> asyncio.Task[None]:
        """Return a noop completed task — null reporter has nothing to heartbeat.

        Returning a task (rather than ``None``) keeps the public
        signature intact so callers can ``await reporter.start_heartbeat(...)``
        and bind the result without special-casing the null path.
        """

        async def _noop() -> None:
            return

        return asyncio.create_task(_noop())

    async def stop_heartbeat(self) -> None:
        return


__all__ = [
    "NullProgressReporter",
    "ProgressEvent",
    "ProgressReporter",
]
