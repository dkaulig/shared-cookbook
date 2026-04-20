"""Tests for :class:`ProgressReporter` + :class:`NullProgressReporter`.

Covers throttle, phase-transition flush, fire-and-forget error handling,
payload composition, and the null-reporter no-op. The BUG-027
heartbeat (start_heartbeat / stop_heartbeat / _last_phase_progress
interaction) is exercised at the bottom of this file.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import httpx
import pytest
import respx

from extractor.progress import (
    NullProgressReporter,
    ProgressEvent,
    ProgressReporter,
)

_CALLBACK_URL = "https://api.test.invalid/api/internal/imports/abc/progress"
_CALLBACK_TOKEN = "test-hmac-token"  # noqa: S105 — fixture value, not a secret


@pytest.fixture(autouse=True)
def _bypass_ssrf_guard() -> Iterator[None]:
    """Make the defence-in-depth SSRF guard resolve test hosts to a public IP.

    The reporter runs :func:`_assert_safe_http_target` before every
    POST. Most progress-reporter tests use ``api.test.invalid`` — a
    TLD that deliberately does not resolve. Without this fixture, the
    guard would block every test's outbound POST. We patch
    ``socket.getaddrinfo`` inside ``extractor.pipeline.url`` (the
    helper's module) to return 1.1.1.1 for any hostname; IP literals
    pass through so tests that specifically exercise SSRF blocks
    (e.g. ``test_reporter_blocks_metadata_callback_url``) still work.
    """

    def _fake(host: str, *args: Any, **kwargs: Any) -> list[Any]:
        try:
            ipaddress.ip_address(host)
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (host, 0))]
        except ValueError:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 0))]

    with patch("extractor.pipeline.url.socket.getaddrinfo", side_effect=_fake):
        yield


# ─────────────────────────────────────────────────────────────────────
# NullProgressReporter
# ─────────────────────────────────────────────────────────────────────


@respx.mock
async def test_null_reporter_is_noop() -> None:
    """NullProgressReporter never issues HTTP requests, regardless of inputs."""
    # Register a route that would 500 if hit — proves no call happens.
    route = respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(500))
    reporter = NullProgressReporter()
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=50))
    await reporter.report(ProgressEvent(phase="transcribing", phase_progress=10))
    await reporter.flush()
    assert not route.called


# ─────────────────────────────────────────────────────────────────────
# Happy-path POST behaviour
# ─────────────────────────────────────────────────────────────────────


@respx.mock
async def test_reporter_sends_initial_event() -> None:
    """First event always POSTs — no throttle state to beat."""
    route = respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(204))
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1, import_id="abc")
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))
    assert route.called
    assert route.call_count == 1


@respx.mock
async def test_reporter_throttles_within_500ms() -> None:
    """Three rapid same-phase reports within <500ms → only one POST."""
    route = respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(204))
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)

    await reporter.report(ProgressEvent(phase="downloading", phase_progress=10))
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=20))
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=30))

    # Only the first survives the throttle; the other two are dropped
    # because we're well under 500 ms between calls.
    assert route.call_count == 1


@respx.mock
async def test_reporter_phase_transition_immediate_flush() -> None:
    """Changing phase bypasses the 500ms throttle → immediate POST."""
    route = respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(204))
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)

    await reporter.report(ProgressEvent(phase="downloading", phase_progress=80))
    # No sleep — within the same event loop tick, phase changes.
    await reporter.report(ProgressEvent(phase="transcribing", phase_progress=0))
    assert route.call_count == 2


@respx.mock
async def test_reporter_passes_attempt_correctly() -> None:
    """The ``attempt`` kwarg lands in the wire payload verbatim."""
    captured: list[dict[str, Any]] = []

    def _record(request: httpx.Request) -> httpx.Response:
        captured.append(_read_json(request))
        return httpx.Response(204)

    respx.post(_CALLBACK_URL).mock(side_effect=_record)
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=2)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=5))
    assert captured == [{"phase": "downloading", "phase_progress": 5, "attempt": 2}]


@respx.mock
async def test_reporter_uses_bearer_token_header() -> None:
    """The Authorization header carries the configured bearer token."""
    captured_headers: list[dict[str, str]] = []

    def _record(request: httpx.Request) -> httpx.Response:
        captured_headers.append(dict(request.headers))
        return httpx.Response(204)

    respx.post(_CALLBACK_URL).mock(side_effect=_record)
    reporter = ProgressReporter(_CALLBACK_URL, "secret-token", attempt=1)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))
    assert captured_headers[0]["authorization"] == "Bearer secret-token"


@respx.mock
async def test_reporter_omits_unset_optional_fields() -> None:
    """Optional fields left None are absent from the body (not null)."""
    captured: list[dict[str, Any]] = []

    def _record(request: httpx.Request) -> httpx.Response:
        captured.append(_read_json(request))
        return httpx.Response(204)

    respx.post(_CALLBACK_URL).mock(side_effect=_record)
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=10))
    body = captured[0]
    # The three required fields are present, the four optionals absent.
    assert set(body.keys()) == {"phase", "phase_progress", "attempt"}


@respx.mock
async def test_reporter_includes_bytes_when_provided() -> None:
    """bytes_done / bytes_total round-trip into the wire payload."""
    captured: list[dict[str, Any]] = []

    def _record(request: httpx.Request) -> httpx.Response:
        captured.append(_read_json(request))
        return httpx.Response(204)

    respx.post(_CALLBACK_URL).mock(side_effect=_record)
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    await reporter.report(
        ProgressEvent(
            phase="downloading",
            phase_progress=25,
            bytes_done=3_400_000,
            bytes_total=12_700_000,
        )
    )
    assert captured[0]["bytes_done"] == 3_400_000
    assert captured[0]["bytes_total"] == 12_700_000


@respx.mock
async def test_reporter_includes_segments_when_provided() -> None:
    """segments_done / segments_total round-trip into the wire payload."""
    captured: list[dict[str, Any]] = []

    def _record(request: httpx.Request) -> httpx.Response:
        captured.append(_read_json(request))
        return httpx.Response(204)

    respx.post(_CALLBACK_URL).mock(side_effect=_record)
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    await reporter.report(
        ProgressEvent(
            phase="transcribing",
            phase_progress=60,
            segments_done=12,
            segments_total=20,
        )
    )
    assert captured[0]["segments_done"] == 12
    assert captured[0]["segments_total"] == 20


# ─────────────────────────────────────────────────────────────────────
# Fire-and-forget error tolerance
# ─────────────────────────────────────────────────────────────────────


@respx.mock
async def test_reporter_swallows_http_5xx() -> None:
    """500 response → logged + swallowed, never raises."""
    respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(500))
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    # Must not raise — a noisy .NET side cannot break extraction.
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))


@respx.mock
async def test_reporter_swallows_401_bad_token() -> None:
    """401 (bad/expired HMAC token) → logged + swallowed."""
    respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(401))
    reporter = ProgressReporter(_CALLBACK_URL, "bogus-token", attempt=1)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))


@respx.mock
async def test_reporter_swallows_404() -> None:
    """404 (unknown importId) → logged + swallowed."""
    respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(404))
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))


@respx.mock
async def test_reporter_swallows_422() -> None:
    """422 (invalid phase / body) → logged + swallowed."""
    respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(422))
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))


@respx.mock
async def test_reporter_swallows_429_rate_limit() -> None:
    """429 (rate limit) → logged + swallowed. UI keeps its last snapshot."""
    respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(429))
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))


@respx.mock
async def test_reporter_swallows_connect_error() -> None:
    """Unreachable callback URL → logged + swallowed, never raises."""
    respx.post(_CALLBACK_URL).mock(side_effect=httpx.ConnectError("unreachable"))
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))


@respx.mock
async def test_reporter_swallows_timeout() -> None:
    """TimeoutException → logged + swallowed, never raises."""
    respx.post(_CALLBACK_URL).mock(side_effect=httpx.TimeoutException("slow server"))
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))


@respx.mock
async def test_reporter_swallows_asyncio_timeout() -> None:
    """asyncio.TimeoutError (now an alias of TimeoutError) → swallowed."""
    respx.post(_CALLBACK_URL).mock(side_effect=TimeoutError())
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))


# ─────────────────────────────────────────────────────────────────────
# Missing-config tolerance
# ─────────────────────────────────────────────────────────────────────


@respx.mock
async def test_reporter_no_url_is_noop() -> None:
    """callback_url=None → no POST even if a token is set."""
    route = respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(500))
    reporter = ProgressReporter(None, _CALLBACK_TOKEN, attempt=1)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))
    assert not route.called


@respx.mock
async def test_reporter_no_token_is_noop() -> None:
    """callback_token=None → no POST (same safety interlock)."""
    route = respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(500))
    reporter = ProgressReporter(_CALLBACK_URL, None, attempt=1)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))
    assert not route.called


# ─────────────────────────────────────────────────────────────────────
# Flush is a no-op placeholder
# ─────────────────────────────────────────────────────────────────────


async def test_reporter_flush_is_safe_on_noop() -> None:
    """flush() never raises, even when the reporter has no URL."""
    reporter = ProgressReporter(None, None, attempt=1)
    await reporter.flush()
    null_reporter = NullProgressReporter()
    await null_reporter.flush()


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def _read_json(request: httpx.Request) -> dict[str, Any]:
    """Decode a captured httpx.Request body as JSON."""
    import json

    raw = request.read()
    decoded = json.loads(raw.decode("utf-8"))
    assert isinstance(decoded, dict)
    return decoded


# Trivial correctness check: fixture imports wire up correctly.
def test_progress_event_defaults_none_optionals() -> None:
    """ProgressEvent defaults all four optional fields to None."""
    ev = ProgressEvent(phase="downloading", phase_progress=50)
    assert ev.bytes_done is None
    assert ev.bytes_total is None
    assert ev.segments_done is None
    assert ev.segments_total is None


# ─────────────────────────────────────────────────────────────────────
# PV2 hardening — SSRF guard + single-client + narrowed logging + force
# ─────────────────────────────────────────────────────────────────────


@respx.mock
async def test_reporter_blocks_metadata_callback_url(caplog: pytest.LogCaptureFixture) -> None:
    """A callback URL that DNS-resolves to link-local metadata must be
    blocked at runtime — defence-in-depth behind the request-parse
    allowlist. The log line must NOT include the URL."""
    import logging

    metadata_url = "http://169.254.169.254/latest"
    # respx would otherwise intercept the POST — register a 500 that
    # proves it is never reached because the SSRF guard fires first.
    route = respx.post(metadata_url).mock(return_value=httpx.Response(500))
    reporter = ProgressReporter(metadata_url, _CALLBACK_TOKEN, attempt=1, import_id="abc")
    with caplog.at_level(logging.WARNING, logger="extractor.progress"):
        await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))
    await reporter.aclose()
    assert not route.called
    # Log line must NOT contain the attacker-chosen URL.
    all_log = " ".join(record.getMessage() for record in caplog.records)
    assert "169.254.169.254" not in all_log


@respx.mock
async def test_reporter_reuses_single_httpx_client() -> None:
    """Two reports on one reporter share a single AsyncClient instance."""
    respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(204))
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    # First call creates the client.
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))
    client_first = reporter._client  # private but stable across ctor
    assert client_first is not None
    # Second call reuses it — phase change bypasses throttle.
    await reporter.report(ProgressEvent(phase="transcribing", phase_progress=0))
    assert reporter._client is client_first
    await reporter.aclose()
    # After aclose, next call lazy-creates a fresh client.
    assert reporter._client is None


@respx.mock
async def test_reporter_aclose_is_idempotent() -> None:
    """Calling aclose twice must not raise."""
    respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(204))
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))
    await reporter.aclose()
    await reporter.aclose()  # second call — no-op, no raise


@respx.mock
async def test_reporter_force_bypasses_throttle() -> None:
    """force=True on ``report`` fires the POST even when within the
    500 ms intra-phase throttle window."""
    route = respx.post(_CALLBACK_URL).mock(return_value=httpx.Response(204))
    reporter = ProgressReporter(_CALLBACK_URL, _CALLBACK_TOKEN, attempt=1)
    await reporter.report(ProgressEvent(phase="vision_analysis", phase_progress=0))
    # Within throttle window, normal report drops silently.
    await reporter.report(ProgressEvent(phase="vision_analysis", phase_progress=50))
    assert route.call_count == 1
    # But force=True fires.
    await reporter.report(
        ProgressEvent(phase="vision_analysis", phase_progress=95),
        force=True,
    )
    assert route.call_count == 2
    await reporter.aclose()


@respx.mock
async def test_reporter_log_never_includes_url_on_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Connection-error log line must carry the exception *type* + a
    truncated message only — never the callback URL itself."""
    import logging

    attacker_host = "evil-attacker-hostname.invalid"
    attacker_url = f"https://{attacker_host}/progress"
    respx.post(attacker_url).mock(side_effect=httpx.ConnectError("Nope"))
    reporter = ProgressReporter(attacker_url, _CALLBACK_TOKEN, attempt=1, import_id="abc")
    with caplog.at_level(logging.WARNING, logger="extractor.progress"):
        # Bypass the runtime SSRF guard by pointing our _post at the
        # attacker host via DNS monkey — in real deployments the
        # pydantic validator + runtime guard would block this first.
        # Here we hit _post directly so only the exception-formatting
        # path runs.
        await reporter._post(ProgressEvent(phase="downloading", phase_progress=0))
    await reporter.aclose()
    all_log = " ".join(record.getMessage() for record in caplog.records)
    assert attacker_host not in all_log


# ─────────────────────────────────────────────────────────────────────
# BUG-027 — heartbeat
# ─────────────────────────────────────────────────────────────────────


class _PostRecorder(ProgressReporter):
    """Bypass network entirely and capture every ``_post`` invocation.

    The heartbeat tests don't need respx — they care about whether the
    reporter is generating ticks at the right interval with the right
    ``force=True`` flag, not what the wire payload looks like.
    """

    def __init__(self) -> None:
        super().__init__(
            callback_url="https://api.test.invalid/p",
            callback_token="t",  # noqa: S106 — fixture, not a real secret
            attempt=1,
        )
        self.posted: list[ProgressEvent] = []

    async def _post(self, event: ProgressEvent) -> None:
        self.posted.append(event)


async def test_heartbeat_emits_every_2s() -> None:
    """A heartbeat running for ~5 s real time produces at least 2
    ticks (the 2 s interval allows for 2-3 wake-ups in 5 s)."""
    reporter = _PostRecorder()
    task = await reporter.start_heartbeat("downloading")
    try:
        # 5 s is enough wall-clock for two 2 s ticks (T=2.0 and T=4.0)
        # plus the initial sleep on entry. Tests run on CI machines
        # where the event loop wakes within a few ms of the requested
        # interval.
        await asyncio.sleep(5.0)
    finally:
        await reporter.stop_heartbeat()
    assert task.cancelled()
    assert len(reporter.posted) >= 2
    # Every tick is the heartbeat phase, not some leftover state.
    assert all(ev.phase == "downloading" for ev in reporter.posted)


async def test_heartbeat_does_not_overwrite_real_progress() -> None:
    """A heartbeat tick re-emits the most recent ``phase_progress`` —
    NOT a hard-coded 0 — so genuine progress reports remain visible."""
    reporter = _PostRecorder()
    # Record a real progress tick first.
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=42))
    real_tick_count = len(reporter.posted)
    assert real_tick_count == 1

    await reporter.start_heartbeat("downloading")
    try:
        # Just past one tick interval — at least one heartbeat fires.
        await asyncio.sleep(2.4)
    finally:
        await reporter.stop_heartbeat()
    heartbeat_events = reporter.posted[real_tick_count:]
    assert len(heartbeat_events) >= 1
    # Every heartbeat carries the last real phase_progress, not 0.
    for ev in heartbeat_events:
        assert ev.phase_progress == 42


async def test_stop_heartbeat_cancels_task() -> None:
    """``stop_heartbeat`` cancels the running task within a short
    grace period and is idempotent across repeated calls."""
    reporter = _PostRecorder()
    task = await reporter.start_heartbeat("transcribing")
    assert not task.done()
    await reporter.stop_heartbeat()
    assert task.cancelled() or task.done()
    # Calling again is a no-op, never raises.
    await reporter.stop_heartbeat()
    await reporter.stop_heartbeat()


async def test_heartbeat_replaces_previous_phase_task() -> None:
    """Calling ``start_heartbeat`` twice without an explicit stop
    cancels the prior task — the pipeline transitions through 3
    phases, each starting a fresh heartbeat."""
    reporter = _PostRecorder()
    first = await reporter.start_heartbeat("downloading")
    second = await reporter.start_heartbeat("transcribing")
    assert first is not second
    assert first.cancelled() or first.done()
    await reporter.stop_heartbeat()


async def test_heartbeat_force_bypasses_throttle() -> None:
    """The heartbeat must use ``force=True`` so the 500 ms throttle
    can never swallow a tick — otherwise two heartbeats arriving back-
    to-back (e.g. via clock skew) would silently drop one."""
    reporter = _PostRecorder()
    # Burn the throttle with a normal report.
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=10))
    pre_heartbeat = len(reporter.posted)

    await reporter.start_heartbeat("downloading")
    try:
        await asyncio.sleep(2.4)
    finally:
        await reporter.stop_heartbeat()
    # Heartbeat tick fired even though we are well within the 500 ms
    # throttle window for this phase.
    assert len(reporter.posted) > pre_heartbeat


async def test_null_reporter_heartbeat_is_noop() -> None:
    """NullProgressReporter still exposes a heartbeat surface so
    callers don't have to special-case the no-op path. The returned
    task completes (no real ticking) and stop_heartbeat is a noop."""
    reporter = NullProgressReporter()
    task = await reporter.start_heartbeat("downloading")
    await asyncio.sleep(0)  # let the noop task run
    assert task.done()
    await reporter.stop_heartbeat()


async def test_aclose_stops_heartbeat() -> None:
    """``aclose`` must cancel any active heartbeat so test teardown
    paths don't leave dangling tasks."""
    reporter = _PostRecorder()
    task = await reporter.start_heartbeat("downloading")
    await reporter.aclose()
    assert task.cancelled() or task.done()


# ─────────────────────────────────────────────────────────────────────
# BUG-031 — heartbeat elapsed-time ramp
# ─────────────────────────────────────────────────────────────────────
#
# These tests patch ``_HEARTBEAT_INTERVAL_S`` down to a tiny value so
# the loop iterates in a few tens of ms, and patch ``time.monotonic``
# inside ``extractor.progress`` to a fake clock so the ramp math is
# deterministic regardless of real wall-clock jitter. The pattern mixes
# monkeypatched module constants with real ``asyncio.sleep`` to drive
# the loop forward — freezegun doesn't play well with ``asyncio.sleep``
# on the running loop, so we fake only the ramp's clock source.


class _FakeClock:
    """Mutable ``time.monotonic`` substitute for heartbeat ramp tests."""

    def __init__(self, start: float = 0.0) -> None:
        self.value = start

    def __call__(self) -> float:
        return self.value


async def _wait_for_n_heartbeats(
    reporter: _PostRecorder,
    baseline: int,
    target: int,
    *,
    timeout_s: float = 2.0,
) -> None:
    """Spin until ``reporter.posted`` has ``target`` ticks past the baseline.

    Uses short real-time sleeps rather than a fixed-length sleep so the
    test tolerates CI jitter — we only assert on the *content* of the
    emitted tick, not its wall-clock timing.
    """
    deadline = asyncio.get_running_loop().time() + timeout_s
    while len(reporter.posted) < baseline + target:
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(
                f"heartbeat did not reach {target} ticks within {timeout_s}s "
                f"(saw {len(reporter.posted) - baseline})"
            )
        await asyncio.sleep(0.01)


async def _wait_for_phase_progress(
    reporter: _PostRecorder,
    expected: int,
    *,
    timeout_s: float = 2.0,
) -> ProgressEvent:
    """Spin until a heartbeat tick with ``phase_progress == expected``
    shows up in ``reporter.posted``, then return that event.

    Lets ramp tests stabilise past a few transient ticks (e.g. a tick
    at the old clock value before the test advanced it) without
    hard-coding tick counts.
    """
    deadline = asyncio.get_running_loop().time() + timeout_s
    while True:
        for event in reporter.posted:
            if event.phase_progress == expected:
                return event
        if asyncio.get_running_loop().time() > deadline:
            snapshot = [ev.phase_progress for ev in reporter.posted]
            raise AssertionError(
                f"heartbeat never emitted phase_progress={expected} "
                f"within {timeout_s}s (saw {snapshot})"
            )
        await asyncio.sleep(0.01)


async def test_heartbeat_ramps_phase_progress_when_yt_dlp_silent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """BUG-031: on silent downloads the heartbeat itself must lift the
    phase_progress via an elapsed-time ramp.

    We don't monkeypatch ``time.monotonic`` because asyncio's event-loop
    clock uses the same symbol — patching it globally would freeze
    ``loop.time()``, which is how ``_wait_for_phase_progress``'s deadline
    works. Instead we accelerate the ramp rate so the test finishes in
    real wall-clock milliseconds.
    """
    monkeypatch.setattr("extractor.progress._HEARTBEAT_INTERVAL_S", 0.02)
    # 1000 %/s ⇒ caps at 95 % after ~95 ms of real elapsed time.
    monkeypatch.setattr("extractor.progress._RAMP_RATE_PERCENT_PER_S", 1000.0)

    reporter = _PostRecorder()
    await reporter.start_heartbeat("downloading")
    try:
        # Expect at least one tick with phase_progress > 0 within 1 s.
        deadline = asyncio.get_running_loop().time() + 1.0
        while True:
            nonzero = [ev for ev in reporter.posted if ev.phase_progress > 0]
            if nonzero:
                assert nonzero[0].phase == "downloading"
                break
            if asyncio.get_running_loop().time() > deadline:
                snapshot = [ev.phase_progress for ev in reporter.posted]
                raise AssertionError(f"heartbeat never ramped above 0 within 1 s (saw {snapshot})")
            await asyncio.sleep(0.005)
    finally:
        await reporter.stop_heartbeat()


async def test_heartbeat_respects_real_yt_dlp_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When real yt-dlp progress exceeds the ramp, ``max(last, ramped)``
    keeps the real value authoritative.

    Slow ramp (3 %/s default) means within the ~100 ms test window the
    ramp stays at 0 ⇒ ``max(50, 0) = 50``. No clock monkeypatch needed.
    """
    monkeypatch.setattr("extractor.progress._HEARTBEAT_INTERVAL_S", 0.02)

    reporter = _PostRecorder()
    await reporter.start_heartbeat("downloading")
    # Simulate a real yt-dlp tick reporting 50 %.
    await reporter.report(ProgressEvent(phase="downloading", phase_progress=50))
    baseline = len(reporter.posted)
    try:
        await _wait_for_n_heartbeats(reporter, baseline=baseline, target=2)
    finally:
        await reporter.stop_heartbeat()

    heartbeat_ticks = reporter.posted[baseline:]
    assert len(heartbeat_ticks) >= 2
    for tick in heartbeat_ticks:
        assert tick.phase_progress == 50, (
            f"heartbeat tick phase_progress={tick.phase_progress}, expected 50 "
            f"(max(last_real=50, ramped=~0) = 50)"
        )


async def test_heartbeat_caps_at_95(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ramp caps at 95 % — the phase only completes via a real
    transition (``start_heartbeat`` of the next phase), never via the
    ramp alone."""
    monkeypatch.setattr("extractor.progress._HEARTBEAT_INTERVAL_S", 0.02)
    # 100_000 %/s ⇒ caps at 95 within a few real ms, well before the
    # _wait_for_phase_progress 2 s deadline elapses.
    monkeypatch.setattr("extractor.progress._RAMP_RATE_PERCENT_PER_S", 100_000.0)

    reporter = _PostRecorder()
    await reporter.start_heartbeat("downloading")
    try:
        event = await _wait_for_phase_progress(reporter, expected=95)
    finally:
        await reporter.stop_heartbeat()

    assert event.phase == "downloading"


async def test_heartbeat_skips_ramp_for_non_ramp_phases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Phases outside ``_RAMP_PHASES`` (e.g. ``post_processing``) must
    NOT be ramped — they're driven by explicit report() calls and
    a phantom ramp would stomp the real value."""
    monkeypatch.setattr("extractor.progress._HEARTBEAT_INTERVAL_S", 0.02)
    # Absurdly fast ramp rate — would hit 95 in ms — proves the non-ramp
    # phase really is unaffected even in an adversarial timing window.
    monkeypatch.setattr("extractor.progress._RAMP_RATE_PERCENT_PER_S", 100_000.0)

    reporter = _PostRecorder()
    await reporter.start_heartbeat("post_processing")
    try:
        await _wait_for_n_heartbeats(reporter, baseline=0, target=2)
    finally:
        await reporter.stop_heartbeat()

    for tick in reporter.posted:
        assert tick.phase == "post_processing"
        assert tick.phase_progress == 0, (
            f"non-ramp phase leaked a ramp tick: phase_progress={tick.phase_progress}"
        )


# Silence unused-import lint when this module has no other pytest use.
_ = pytest
