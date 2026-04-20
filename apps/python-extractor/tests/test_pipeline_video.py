"""Tests for the yt-dlp progress wrapper (BUG-027).

These exercise :func:`extractor.pipeline.video._make_ytdlp_progress_wrapper`
in isolation — no real yt-dlp / network involved. The wrapper is the
single source of truth for "what percent should the UI show?" during
the downloading phase, so its three progress-source heuristics
(fragment_count → byte_total → elapsed-time) are the surface area
worth defending with regression tests.

Background: Facebook / Instagram / TikTok URLs frequently resolve to
fragmented HLS / m3u8 streams where ``total_bytes=0`` for the entire
download. The pre-fix wrapper returned 0 % the whole time, leaving the
UI stuck at the phase boundary for 30-90 s. The new heuristics give
the UI a steadily-rising progress signal even when total is unknown.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

from extractor.pipeline.video import _make_ytdlp_progress_wrapper


class _Recorder:
    """Capture ``(done, total, percent_override)`` calls from the wrapper.

    Replaces the pipeline-side ``on_progress`` hook so tests can assert
    on the exact values forwarded to the ProgressEvent layer.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[int, int, int | None]] = []

    def __call__(self, done: int, total: int, *, percent_override: int | None = None) -> None:
        self.calls.append((done, total, percent_override))


def test_ytdlp_wrapper_uses_fragment_count_when_present() -> None:
    """HLS-style ``fragment_index`` + ``fragment_count`` win over byte
    counts as the authoritative progress source — fragmented streams
    are exactly the case where ``total_bytes`` is unreliable."""
    recorder = _Recorder()
    wrapper = _make_ytdlp_progress_wrapper(recorder)
    wrapper(
        {
            "status": "downloading",
            "downloaded_bytes": 1234,
            "total_bytes": 0,  # unknown — but fragment info wins anyway
            "fragment_index": 5,
            "fragment_count": 20,
        }
    )
    assert len(recorder.calls) == 1
    done, _total, percent_override = recorder.calls[0]
    assert percent_override == 25
    # Raw bytes_done is still forwarded so the UI's byte-counter has
    # something to render even in the fragment-progress path.
    assert done == 1234


def test_ytdlp_wrapper_fragment_count_wins_over_total_bytes() -> None:
    """Even when both byte total and fragment counts are present, the
    fragment ratio wins — fragments map to wall-clock time more
    reliably than HLS byte estimates."""
    recorder = _Recorder()
    wrapper = _make_ytdlp_progress_wrapper(recorder)
    wrapper(
        {
            "status": "downloading",
            "downloaded_bytes": 1_000_000,
            "total_bytes": 10_000_000,  # 10 % by bytes
            "fragment_index": 8,
            "fragment_count": 10,  # 80 % by fragments
        }
    )
    _, _, percent_override = recorder.calls[0]
    assert percent_override == 80


def test_ytdlp_wrapper_falls_back_to_total_bytes_when_no_fragments() -> None:
    """Classic mp4 path — no fragment metadata, byte ratio is the
    answer. Same percentage the pre-fix wrapper produced."""
    recorder = _Recorder()
    wrapper = _make_ytdlp_progress_wrapper(recorder)
    wrapper(
        {
            "status": "downloading",
            "downloaded_bytes": 3_000_000,
            "total_bytes": 12_000_000,
        }
    )
    _, _, percent_override = recorder.calls[0]
    assert percent_override == 25


def test_ytdlp_wrapper_uses_total_bytes_estimate_as_secondary_fallback() -> None:
    """When ``total_bytes`` is missing but ``total_bytes_estimate`` is
    present (HLS playlists with declared duration), use the estimate."""
    recorder = _Recorder()
    wrapper = _make_ytdlp_progress_wrapper(recorder)
    wrapper(
        {
            "status": "downloading",
            "downloaded_bytes": 600_000,
            "total_bytes_estimate": 1_200_000,
        }
    )
    _, _, percent_override = recorder.calls[0]
    assert percent_override == 50


def test_ytdlp_wrapper_uses_elapsed_time_when_total_unknown() -> None:
    """No fragments, no totals → elapsed-time ramp at 3 % / second.

    Drives a virtual clock by patching ``time.monotonic`` inside the
    wrapper module so the factory and each tick read the same fake
    timestamp. The elapsed-time ramp produces the visible "alive"
    progress that BUG-027 was reported against.
    """
    recorder = _Recorder()
    clock = {"value": 0.0}

    with patch("extractor.pipeline.video.time.monotonic", lambda: clock["value"]):
        # Factory captures clock=0.0 as the ramp start.
        wrapper = _make_ytdlp_progress_wrapper(recorder)
        observed: list[int | None] = []
        for elapsed in (0.0, 1.0, 2.0, 3.0, 10.0):
            clock["value"] = elapsed
            wrapper(
                {
                    "status": "downloading",
                    "downloaded_bytes": int(elapsed * 100_000),
                    "total_bytes": 0,
                }
            )
            observed.append(recorder.calls[-1][2])

    assert observed == [0, 3, 6, 9, 30]


def test_ytdlp_wrapper_caps_elapsed_at_95() -> None:
    """Elapsed-time ramp must never exceed 95 % so the phase only
    completes when the real download-finished transition fires."""
    recorder = _Recorder()
    clock = {"value": 0.0}

    with patch("extractor.pipeline.video.time.monotonic", lambda: clock["value"]):
        wrapper = _make_ytdlp_progress_wrapper(recorder)
        clock["value"] = 1000.0
        wrapper(
            {
                "status": "downloading",
                "downloaded_bytes": 0,
                "total_bytes": 0,
            }
        )

    _, _, percent_override = recorder.calls[0]
    assert percent_override == 95


def test_ytdlp_wrapper_explicit_start_time_anchors_the_ramp() -> None:
    """Passing an explicit ``start_time`` lets the caller anchor the
    elapsed-time ramp to a moment before factory call (e.g. when the
    pipeline already fired its downloading@0 % event a beat earlier)."""
    recorder = _Recorder()
    clock = {"value": 100.0}

    with patch("extractor.pipeline.video.time.monotonic", lambda: clock["value"]):
        # start_time = 90.0 means we are already 10 s into the ramp at
        # construction; one more second on the clock = 11 s elapsed.
        wrapper = _make_ytdlp_progress_wrapper(recorder, start_time=90.0)
        clock["value"] = 101.0
        wrapper(
            {
                "status": "downloading",
                "downloaded_bytes": 0,
                "total_bytes": 0,
            }
        )

    _, _, percent_override = recorder.calls[0]
    assert percent_override == 33  # 11 s * 3 % / s


def test_ytdlp_wrapper_ignores_non_downloading_status() -> None:
    """``finished`` / ``error`` events are surfaced via the sync
    return path, so the wrapper must not forward them as progress
    ticks."""
    recorder = _Recorder()
    wrapper = _make_ytdlp_progress_wrapper(recorder)
    wrapper({"status": "finished", "downloaded_bytes": 99, "total_bytes": 99})
    wrapper({"status": "error"})
    assert recorder.calls == []


def test_ytdlp_wrapper_handles_non_numeric_values_gracefully() -> None:
    """A bad hook payload (string in a numeric field) must not raise
    — yt-dlp itself would otherwise abort the download."""
    recorder = _Recorder()
    wrapper = _make_ytdlp_progress_wrapper(recorder)
    bad: dict[str, Any] = {
        "status": "downloading",
        "downloaded_bytes": "not-a-number",
        "total_bytes": "also-bad",
    }
    wrapper(bad)
    # Silently dropped; no call recorded.
    assert recorder.calls == []


def test_ytdlp_wrapper_forwards_bytes_done_even_with_unknown_total() -> None:
    """Even on the elapsed-time fallback path, raw ``downloaded_bytes``
    is still passed through so the UI's byte counter renders. The
    pipeline maps ``total=0`` to ``bytes_total=None`` downstream, which
    the frontend's PhaseDetailCard already tolerates."""
    recorder = _Recorder()
    wrapper = _make_ytdlp_progress_wrapper(recorder)
    wrapper(
        {
            "status": "downloading",
            "downloaded_bytes": 4_242_424,
            "total_bytes": 0,
        }
    )
    done, total, _percent = recorder.calls[0]
    assert done == 4_242_424
    assert total == 0
