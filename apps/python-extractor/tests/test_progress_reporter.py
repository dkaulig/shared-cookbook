"""Tests for :class:`ProgressReporter` + :class:`NullProgressReporter`.

Covers throttle, phase-transition flush, fire-and-forget error handling,
payload composition, and the null-reporter no-op.
"""

from __future__ import annotations

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


# Silence unused-import lint when this module has no other pytest use.
_ = pytest
