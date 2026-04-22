"""COVER-0 slice A — video-path candidate thumbnail assembly.

The pipeline merges up to 2 yt-dlp thumbnails (top by resolution) with
up to 4 ffmpeg-extracted frames (at 15 / 35 / 60 / 85 % of duration)
into a capped-at-6 ordered list, deduping against yt-dlp thumbnails
that land within 500 ms of a ffmpeg frame (yt-dlp wins — it's already
on a CDN).

ffmpeg is not installed in this sandbox; tests inject a
:class:`StubFrameExtractor` to avoid shelling out. The production
:class:`FfmpegFrameExtractor` is exercised indirectly at runtime in
Docker where the binary is available.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from extractor.pipeline.video import (
    FrameExtractor,
    StubFrameExtractor,
    ThumbnailCandidate,
    YtDlpThumbnail,
    assemble_video_candidates,
)


def _yt(url: str, *, width: int | None = None, timestamp: float | None = None) -> YtDlpThumbnail:
    """Build a yt-dlp-thumbnail record for tests."""
    return YtDlpThumbnail(url=url, width=width, timestamp=timestamp)


def _run(
    *,
    ytdlp_thumbs: list[YtDlpThumbnail],
    mp4_path: Path,
    duration_seconds: float,
    frame_extractor: FrameExtractor,
) -> list[str]:
    """Sync wrapper around the async assembler for test ergonomics."""
    return asyncio.run(
        assemble_video_candidates(
            ytdlp_thumbs=ytdlp_thumbs,
            mp4_path=mp4_path,
            duration_seconds=duration_seconds,
            frame_extractor=frame_extractor,
        )
    )


def test_two_ytdlp_plus_four_frames_produces_six_candidates(tmp_path: Path) -> None:
    """3 yt-dlp thumbnails (top 2 picked) + 20-second video → 6 total."""
    ytdlp_thumbs = [
        _yt("https://cdn.example/low.jpg", width=320),
        _yt("https://cdn.example/mid.jpg", width=720),
        _yt("https://cdn.example/hi.jpg", width=1280),
    ]
    extractor: FrameExtractor = StubFrameExtractor(
        frames=[
            ThumbnailCandidate(url="file:///tmp/frame-0.jpg", timestamp=3.0),
            ThumbnailCandidate(url="file:///tmp/frame-1.jpg", timestamp=7.0),
            ThumbnailCandidate(url="file:///tmp/frame-2.jpg", timestamp=12.0),
            ThumbnailCandidate(url="file:///tmp/frame-3.jpg", timestamp=17.0),
        ]
    )
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    candidates = _run(
        ytdlp_thumbs=ytdlp_thumbs,
        mp4_path=mp4,
        duration_seconds=20.0,
        frame_extractor=extractor,
    )
    assert len(candidates) == 6
    # Top 2 yt-dlp thumbs (sorted by width desc) come first.
    assert candidates[:2] == ["https://cdn.example/hi.jpg", "https://cdn.example/mid.jpg"]
    # Followed by 4 ffmpeg frames in timestamp order.
    assert candidates[2:] == [
        "file:///tmp/frame-0.jpg",
        "file:///tmp/frame-1.jpg",
        "file:///tmp/frame-2.jpg",
        "file:///tmp/frame-3.jpg",
    ]


def test_one_ytdlp_short_video_emits_one_plus_frames(tmp_path: Path) -> None:
    """Single yt-dlp thumb + 5 s video still emits the yt-dlp thumb +
    whatever frames the extractor produces (fewer than 4 is OK)."""
    ytdlp_thumbs = [_yt("https://cdn.example/only.jpg", width=1080)]
    extractor: FrameExtractor = StubFrameExtractor(
        frames=[
            ThumbnailCandidate(url="file:///tmp/frame-0.jpg", timestamp=0.75),
            ThumbnailCandidate(url="file:///tmp/frame-1.jpg", timestamp=1.75),
        ]
    )
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    candidates = _run(
        ytdlp_thumbs=ytdlp_thumbs,
        mp4_path=mp4,
        duration_seconds=5.0,
        frame_extractor=extractor,
    )
    assert candidates == [
        "https://cdn.example/only.jpg",
        "file:///tmp/frame-0.jpg",
        "file:///tmp/frame-1.jpg",
    ]


def test_ffmpeg_failure_degrades_to_remaining_frames(tmp_path: Path) -> None:
    """If the frame extractor returns fewer than requested, the
    pipeline keeps what it got rather than aborting. The candidate
    list is best-effort; a partial result is strictly better than
    none."""

    class _FlakyExtractor:
        async def extract(
            self, *, mp4_path: Path, timestamps: list[float]
        ) -> list[ThumbnailCandidate]:
            # Only 2 timestamps out of 4 succeeded.
            return [
                ThumbnailCandidate(url="file:///tmp/ok-0.jpg", timestamp=timestamps[0]),
                ThumbnailCandidate(url="file:///tmp/ok-1.jpg", timestamp=timestamps[3]),
            ]

    ytdlp_thumbs = [_yt("https://cdn.example/a.jpg", width=720)]
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    candidates = _run(
        ytdlp_thumbs=ytdlp_thumbs,
        mp4_path=mp4,
        duration_seconds=30.0,
        frame_extractor=_FlakyExtractor(),
    )
    assert candidates == [
        "https://cdn.example/a.jpg",
        "file:///tmp/ok-0.jpg",
        "file:///tmp/ok-1.jpg",
    ]


def test_ffmpeg_raises_entire_extraction_yields_ytdlp_only(tmp_path: Path) -> None:
    """If the frame extractor raises, the pipeline still completes
    with just the yt-dlp thumbnails — frame extraction is best-effort,
    never a pipeline-fatal error."""

    class _RaisingExtractor:
        async def extract(
            self, *, mp4_path: Path, timestamps: list[float]
        ) -> list[ThumbnailCandidate]:
            raise RuntimeError("ffmpeg unavailable")

    ytdlp_thumbs = [_yt("https://cdn.example/a.jpg", width=720)]
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    candidates = _run(
        ytdlp_thumbs=ytdlp_thumbs,
        mp4_path=mp4,
        duration_seconds=30.0,
        frame_extractor=_RaisingExtractor(),
    )
    assert candidates == ["https://cdn.example/a.jpg"]


def test_dedupe_prefers_ytdlp_when_frame_within_500ms(tmp_path: Path) -> None:
    """yt-dlp thumbnail tagged at t=3.0s and ffmpeg frame at t=3.2s
    (within 500 ms) → drop the ffmpeg frame, keep the yt-dlp thumbnail."""
    ytdlp_thumbs = [_yt("https://cdn.example/ytd.jpg", width=1080, timestamp=3.0)]
    extractor: FrameExtractor = StubFrameExtractor(
        frames=[
            ThumbnailCandidate(url="file:///tmp/close.jpg", timestamp=3.2),
            ThumbnailCandidate(url="file:///tmp/far.jpg", timestamp=7.0),
        ]
    )
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    candidates = _run(
        ytdlp_thumbs=ytdlp_thumbs,
        mp4_path=mp4,
        duration_seconds=20.0,
        frame_extractor=extractor,
    )
    # "close.jpg" dedupes; only far.jpg and the yt-dlp thumb survive.
    assert candidates == ["https://cdn.example/ytd.jpg", "file:///tmp/far.jpg"]


def test_dedupe_tolerates_ytdlp_without_timestamp(tmp_path: Path) -> None:
    """yt-dlp thumbs usually don't carry a timestamp (they're CDN
    posters, not frame-extracts). Missing timestamp means the dedupe
    guard can't fire for that pair — every ffmpeg frame is kept."""
    ytdlp_thumbs = [_yt("https://cdn.example/poster.jpg", width=1080, timestamp=None)]
    extractor: FrameExtractor = StubFrameExtractor(
        frames=[
            ThumbnailCandidate(url="file:///tmp/a.jpg", timestamp=3.0),
            ThumbnailCandidate(url="file:///tmp/b.jpg", timestamp=7.0),
        ]
    )
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    candidates = _run(
        ytdlp_thumbs=ytdlp_thumbs,
        mp4_path=mp4,
        duration_seconds=20.0,
        frame_extractor=extractor,
    )
    assert candidates == [
        "https://cdn.example/poster.jpg",
        "file:///tmp/a.jpg",
        "file:///tmp/b.jpg",
    ]


def test_assembly_caps_at_six(tmp_path: Path) -> None:
    """Invariant: even if every source overshoots, result is <= 6."""
    ytdlp_thumbs = [_yt(f"https://cdn.example/a{i}.jpg", width=1000 + i) for i in range(5)]
    extractor: FrameExtractor = StubFrameExtractor(
        frames=[
            ThumbnailCandidate(url=f"file:///tmp/f{i}.jpg", timestamp=float(i * 3))
            for i in range(8)
        ]
    )
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    candidates = _run(
        ytdlp_thumbs=ytdlp_thumbs,
        mp4_path=mp4,
        duration_seconds=60.0,
        frame_extractor=extractor,
    )
    assert len(candidates) == 6
    # Top 2 yt-dlp thumbs (highest width) + 4 frames (in order).
    assert candidates[:2] == [
        "https://cdn.example/a4.jpg",
        "https://cdn.example/a3.jpg",
    ]


def test_percent_timestamps_at_15_35_60_85_of_duration(tmp_path: Path) -> None:
    """The pipeline requests frames at 15 / 35 / 60 / 85 % of the
    video duration (design doc §"Video imports")."""

    captured: dict[str, list[float]] = {"timestamps": []}

    class _RecordingExtractor:
        async def extract(
            self, *, mp4_path: Path, timestamps: list[float]
        ) -> list[ThumbnailCandidate]:
            captured["timestamps"] = list(timestamps)
            return []

    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    candidates = _run(
        ytdlp_thumbs=[],
        mp4_path=mp4,
        duration_seconds=100.0,
        frame_extractor=_RecordingExtractor(),
    )
    assert candidates == []
    assert captured["timestamps"] == [15.0, 35.0, 60.0, 85.0]


def test_zero_duration_still_returns_ytdlp_thumbs(tmp_path: Path) -> None:
    """A video whose duration yt-dlp didn't surface (0 / None) still
    gets the yt-dlp thumbs; frame extraction is skipped because we
    can't compute percent timestamps."""
    ytdlp_thumbs = [_yt("https://cdn.example/ytd.jpg", width=1080)]

    class _ShouldNotBeCalled:
        async def extract(
            self, *, mp4_path: Path, timestamps: list[float]
        ) -> list[ThumbnailCandidate]:
            raise AssertionError("frame extractor must not be invoked when duration unknown")

    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    candidates = _run(
        ytdlp_thumbs=ytdlp_thumbs,
        mp4_path=mp4,
        duration_seconds=0.0,
        frame_extractor=_ShouldNotBeCalled(),
    )
    assert candidates == ["https://cdn.example/ytd.jpg"]


def test_ytdlp_thumbs_sorted_by_width_descending(tmp_path: Path) -> None:
    """When yt-dlp's ``thumbnails`` list order doesn't align with
    resolution (happens on IG — they emit a 1440-wide Reels poster
    AFTER a 320-wide preview), the pipeline sorts by width desc to
    keep the sharpest thumbs first."""
    ytdlp_thumbs = [
        _yt("https://cdn.example/small.jpg", width=320),
        _yt("https://cdn.example/big.jpg", width=1440),
        _yt("https://cdn.example/mid.jpg", width=720),
    ]
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    candidates = _run(
        ytdlp_thumbs=ytdlp_thumbs,
        mp4_path=mp4,
        duration_seconds=0.0,  # no frames -> candidates are yt-dlp only
        frame_extractor=StubFrameExtractor(frames=[]),
    )
    # Top 2 by width descending.
    assert candidates == [
        "https://cdn.example/big.jpg",
        "https://cdn.example/mid.jpg",
    ]


def test_ytdlp_thumbs_without_width_use_yt_dlp_order(tmp_path: Path) -> None:
    """yt-dlp occasionally omits ``width``. yt-dlp documents its
    thumbnails list as worst-to-best, so the top 2 are the LAST two
    entries (reversed) when widths are unavailable."""
    ytdlp_thumbs = [
        _yt("https://cdn.example/a.jpg", width=None),
        _yt("https://cdn.example/b.jpg", width=None),
        _yt("https://cdn.example/c.jpg", width=None),
    ]
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    candidates = _run(
        ytdlp_thumbs=ytdlp_thumbs,
        mp4_path=mp4,
        duration_seconds=0.0,
        frame_extractor=StubFrameExtractor(frames=[]),
    )
    assert candidates == ["https://cdn.example/c.jpg", "https://cdn.example/b.jpg"]


@pytest.mark.asyncio
async def test_ffmpeg_frame_extractor_uses_argv_list_not_shell(tmp_path: Path) -> None:
    """Security: the ffmpeg invocation must pass each argument as its
    own argv entry so a hostile file path can't inject via shell
    metachars. The test introspects the subprocess call via a
    monkey-patched ``create_subprocess_exec``."""
    import asyncio as _asyncio

    from extractor.pipeline.video import FfmpegFrameExtractor

    captured_args: list[list[str]] = []

    async def _fake_spawn(*args: str, **_kwargs: object) -> object:
        captured_args.append(list(args))

        class _FakeProc:
            returncode = 0

            async def communicate(self) -> tuple[bytes, bytes]:
                return b"", b""

        return _FakeProc()

    orig_spawn = _asyncio.create_subprocess_exec
    _asyncio.create_subprocess_exec = _fake_spawn  # type: ignore[assignment]
    try:
        mp4 = tmp_path / "video.mp4"
        mp4.write_bytes(b"stub")
        extractor = FfmpegFrameExtractor(
            output_dir=tmp_path,
            url_base="http://python-extractor:8000/extractor/frames/abc",
        )
        # Pre-create the expected output files so the post-extract
        # existence check passes without a real ffmpeg.
        for i in range(2):
            (tmp_path / f"{i}.jpg").write_bytes(b"fake")
        await extractor.extract(mp4_path=mp4, timestamps=[1.0, 2.0])
    finally:
        _asyncio.create_subprocess_exec = orig_spawn  # type: ignore[assignment]

    assert captured_args, "ffmpeg was never invoked"
    for argv in captured_args:
        # First arg is the binary; remaining args are passed one-per-
        # list-entry (never shell-joined).
        assert argv[0] == "ffmpeg"
        assert all(isinstance(a, str) for a in argv)


@pytest.mark.asyncio
async def test_ffmpeg_frame_extractor_emits_http_urls(tmp_path: Path) -> None:
    """COVER-0 fix: ffmpeg-extracted frames must surface as HTTP URLs
    (not ``file://`` URIs) so the .NET CandidateAttacher can fetch them
    through its regular HTTP client. The URL base points at the
    python-extractor's own ``/extractor/frames/<dir_id>`` route."""
    import asyncio as _asyncio

    from extractor.pipeline.video import FfmpegFrameExtractor

    async def _fake_spawn(*_args: str, **_kwargs: object) -> object:
        class _FakeProc:
            returncode = 0

            async def communicate(self) -> tuple[bytes, bytes]:
                return b"", b""

        return _FakeProc()

    orig_spawn = _asyncio.create_subprocess_exec
    _asyncio.create_subprocess_exec = _fake_spawn  # type: ignore[assignment]
    try:
        mp4 = tmp_path / "video.mp4"
        mp4.write_bytes(b"stub")
        url_base = "http://python-extractor:8000/extractor/frames/abc-123"
        extractor = FfmpegFrameExtractor(output_dir=tmp_path, url_base=url_base)
        # Pre-create exactly the files ffmpeg "would" emit at indices 0..2.
        for i in range(3):
            (tmp_path / f"{i}.jpg").write_bytes(b"fake")
        frames = await extractor.extract(mp4_path=mp4, timestamps=[1.0, 2.0, 3.0])
    finally:
        _asyncio.create_subprocess_exec = orig_spawn  # type: ignore[assignment]

    assert [f.url for f in frames] == [
        f"{url_base}/0.jpg",
        f"{url_base}/1.jpg",
        f"{url_base}/2.jpg",
    ]
    # No ``file://`` URL must leak from the extractor — the whole point
    # of the fix.
    for frame in frames:
        assert not frame.url.startswith("file:")
