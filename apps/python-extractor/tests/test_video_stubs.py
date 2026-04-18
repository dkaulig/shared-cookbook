"""Tests for the video-path protocols + test stubs.

The real yt-dlp + faster-whisper implementations need network + heavy
model weights, so we test only the protocol contracts against the
in-process stubs here. The production implementations are exercised by
the skipped-by-default live integration test.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from extractor.pipeline.video import (
    ExtractionError,
    StubDownloader,
    StubTranscriber,
    Transcriber,
    VideoAssets,
    VideoDownloader,
)


def test_video_assets_carries_path_title_description_thumbnail(tmp_path: Path) -> None:
    """VideoAssets is the minimal bag the pipeline needs from the downloader."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"\x00\x00\x00\x20ftyp")  # not a real mp4, just a path we own
    assets = VideoAssets(
        mp4_path=mp4,
        title="Ein Video",
        description="Beschreibung",
        thumbnail_url="https://example.com/thumb.jpg",
    )
    assert assets.mp4_path == mp4
    assert assets.title == "Ein Video"
    assert assets.description == "Beschreibung"
    assert assets.thumbnail_url == "https://example.com/thumb.jpg"


async def test_stub_downloader_returns_scripted_assets(tmp_path: Path) -> None:
    """StubDownloader returns whatever VideoAssets it was constructed with."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"not a real mp4")
    assets = VideoAssets(
        mp4_path=mp4,
        title="Rezept-Video",
        description="Kurze Caption",
        thumbnail_url=None,
    )
    downloader: VideoDownloader = StubDownloader(assets=assets)
    result = await downloader.download(url="https://youtu.be/abc", workdir=tmp_path)
    assert result is assets


async def test_stub_downloader_raises_when_configured_to_fail(tmp_path: Path) -> None:
    """StubDownloader can be told to raise the canonical source_unavailable
    ExtractionError so tests can exercise the private-video path."""
    downloader = StubDownloader(
        error=ExtractionError(
            "source_unavailable",
            "Das Video ist nicht verfügbar.",
        )
    )
    with pytest.raises(ExtractionError) as exc_info:
        await downloader.download(url="https://youtu.be/private", workdir=tmp_path)
    assert exc_info.value.code == "source_unavailable"


async def test_stub_transcriber_returns_scripted_text(tmp_path: Path) -> None:
    """StubTranscriber ignores the mp4 and returns the scripted transcript."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"")
    transcriber: Transcriber = StubTranscriber(transcript="Mehl, Eier, Milch.")
    text = await transcriber.transcribe(mp4)
    assert text == "Mehl, Eier, Milch."


async def test_stub_transcriber_default_is_empty_string(tmp_path: Path) -> None:
    """Default transcript is an empty string so callers handle it uniformly."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"")
    transcriber = StubTranscriber()
    assert await transcriber.transcribe(mp4) == ""


def test_extraction_error_carries_code_and_message() -> None:
    """ExtractionError is the pipeline's own (not an LLM error) exception."""
    err = ExtractionError("source_unavailable", "Das Video ist nicht verfügbar.")
    assert err.code == "source_unavailable"
    assert "nicht verfügbar" in str(err)
