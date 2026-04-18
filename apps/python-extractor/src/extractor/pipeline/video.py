"""Video-path abstractions + production + stub implementations.

Two protocols keep the pipeline unit-testable without real network /
heavy model downloads:

- :class:`VideoDownloader` — wraps ``yt-dlp`` in production
  (:class:`YtDlpDownloader`). The stub (:class:`StubDownloader`) lets
  tests hand back canned ``VideoAssets`` or raise a canned
  :class:`ExtractionError`.
- :class:`Transcriber` — wraps ``faster-whisper`` in production
  (:class:`FasterWhisperTranscriber`). The stub
  (:class:`StubTranscriber`) returns a scripted transcript string.

:class:`ExtractionError` is the pipeline's own error type (distinct
from :class:`extractor.llm.LLMProviderError`). It's raised for
recoverable source-side failures — private videos, deleted posts,
blog-fetch 4xx — and carries a German user-facing ``message`` the
frontend can render as-is.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol, runtime_checkable

# yt-dlp ships no stubs; module-level named ignore with a reason is the
# sanctioned pattern. Do NOT broaden to ``ignore_errors`` — we still
# want type-checking for our own wrapper code.
import yt_dlp  # type: ignore[import-untyped]  # no py.typed marker upstream
from yt_dlp.utils import DownloadError  # type: ignore[import-untyped]  # no py.typed

logger = logging.getLogger("extractor.pipeline.video")

ExtractionErrorCode = Literal[
    "source_unavailable",
    "transcription_failed",
]
"""Discriminator for :class:`ExtractionError`.

Names stay stable across slices — the .NET side (P2-5 / P2-6) branches
on them to decide retry vs user-visible error.
"""


class ExtractionError(Exception):
    """Pipeline-level error with a discriminator code + German message.

    Use this instead of :class:`LLMProviderError` for source-side
    failures (downloader / transcriber). The endpoint layer maps
    ``source_unavailable`` → HTTP 422 (client can't do anything about a
    private video) and ``transcription_failed`` → HTTP 500.
    """

    def __init__(self, code: ExtractionErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: ExtractionErrorCode = code


@dataclass(frozen=True, slots=True)
class VideoAssets:
    """What a downloader hands back to the pipeline.

    - ``mp4_path`` — path to the downloaded file. Caller owns the
      surrounding ``tempfile.TemporaryDirectory`` and cleans up after.
    - ``title`` / ``description`` — yt-dlp metadata. ``title`` is
      always a string (empty if unknown); ``description`` may be empty.
    - ``thumbnail_url`` — ``None`` when yt-dlp didn't surface one.
    """

    mp4_path: Path
    title: str
    description: str
    thumbnail_url: str | None


@runtime_checkable
class VideoDownloader(Protocol):
    """Download a video's mp4 + metadata. Async so the pipeline is async-friendly."""

    async def download(self, *, url: str, workdir: Path) -> VideoAssets:
        """Fetch the video into ``workdir`` and return its assets.

        Raises :class:`ExtractionError` (``source_unavailable``) on any
        non-transient failure (private, deleted, geo-blocked, 404).
        """
        ...


@runtime_checkable
class Transcriber(Protocol):
    """Transcribe a downloaded video's audio into plain text."""

    async def transcribe(self, mp4_path: Path) -> str:
        """Return a plain-text transcript. Empty string when no audio /
        no speech detected. Raises :class:`ExtractionError`
        (``transcription_failed``) on model-level failures."""
        ...


# ─────────────────────────────────────────────────────────────────────
# Stubs — unit-test doubles.
# ─────────────────────────────────────────────────────────────────────


class StubDownloader:
    """In-memory stand-in for :class:`VideoDownloader`.

    Construct with either ``assets=`` (happy path) or ``error=``
    (failure path). Calling :meth:`download` with an instance that has
    neither raises a plain :class:`ExtractionError` to surface a test
    setup mistake loudly.
    """

    def __init__(
        self,
        *,
        assets: VideoAssets | None = None,
        error: ExtractionError | None = None,
    ) -> None:
        self._assets = assets
        self._error = error

    async def download(self, *, url: str, workdir: Path) -> VideoAssets:
        if self._error is not None:
            raise self._error
        if self._assets is None:
            raise ExtractionError(
                "source_unavailable",
                "StubDownloader was neither configured with assets nor error.",
            )
        return self._assets


class StubTranscriber:
    """In-memory stand-in for :class:`Transcriber`.

    Default is an empty string so tests that don't care about the
    transcript can pass ``StubTranscriber()`` and still exercise the
    pipeline.
    """

    def __init__(self, transcript: str = "") -> None:
        self._transcript = transcript

    async def transcribe(self, mp4_path: Path) -> str:
        return self._transcript


# ─────────────────────────────────────────────────────────────────────
# Production implementations.
# ─────────────────────────────────────────────────────────────────────


# Default yt-dlp options. Kept module-scoped so the class stays small
# and ops can grep for the knobs at once.
_YTDLP_OPTIONS: dict[str, Any] = {
    "quiet": True,
    "no_warnings": True,
    # Cap the download to the smallest acceptable quality — audio is
    # all we actually need for transcription, and the VPS bandwidth is
    # limited.
    "format": "best[height<=480]/best",
    "noplaylist": True,
    # Skip the slowest post-processing; we don't need re-encoded output.
    "postprocessors": [],
}


class YtDlpDownloader:
    """Production :class:`VideoDownloader` backed by ``yt-dlp``.

    yt-dlp is synchronous; we dispatch via ``asyncio.to_thread`` so the
    FastAPI event loop stays responsive for other requests.
    """

    async def download(self, *, url: str, workdir: Path) -> VideoAssets:
        logger.info("yt-dlp download start host=%s", _redact(url))
        try:
            info = await asyncio.to_thread(self._download_sync, url, workdir)
        except DownloadError as exc:
            logger.warning("yt-dlp download failed host=%s err=%s", _redact(url), exc)
            raise ExtractionError(
                "source_unavailable",
                "Das Video ist nicht verfügbar — vielleicht privat oder gelöscht.",
            ) from exc

        mp4_path = Path(info["_resolved_path"])
        assets = VideoAssets(
            mp4_path=mp4_path,
            title=str(info.get("title") or ""),
            description=str(info.get("description") or ""),
            thumbnail_url=_first_thumbnail_url(info),
        )
        logger.info("yt-dlp download done host=%s", _redact(url))
        return assets

    @staticmethod
    def _download_sync(url: str, workdir: Path) -> dict[str, Any]:
        """Synchronous yt-dlp call. Runs in a worker thread."""
        outtmpl = str(workdir / "%(id)s.%(ext)s")
        options: dict[str, Any] = {**_YTDLP_OPTIONS, "outtmpl": outtmpl}
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            if info is None:
                raise DownloadError("yt-dlp returned no info for URL")
            # ``prepare_filename`` gives us the real on-disk path.
            resolved = ydl.prepare_filename(info)
        info_dict = dict(info) if isinstance(info, dict) else {}
        info_dict["_resolved_path"] = resolved
        return info_dict


def _first_thumbnail_url(info: dict[str, Any]) -> str | None:
    """Pull the best thumbnail URL out of yt-dlp's info dict.

    yt-dlp puts one or many thumbnails in ``thumbnails`` (list of
    ``{"url": ...}``) + sometimes a single ``thumbnail`` field. Prefer
    the last entry of ``thumbnails`` (highest quality by yt-dlp
    convention), fall back to the single field.
    """
    thumbnails = info.get("thumbnails")
    if isinstance(thumbnails, list) and thumbnails:
        last = thumbnails[-1]
        if isinstance(last, dict):
            url = last.get("url")
            if isinstance(url, str):
                return url
    single = info.get("thumbnail")
    if isinstance(single, str):
        return single
    return None


def _redact(url: str) -> str:
    """Reduce a URL to ``scheme://host`` for log lines (no query, no path)."""
    # Minimal hand-parse — ``urllib.parse`` is overkill for a log line and
    # keeps the call cheap.
    try:
        scheme, rest = url.split("://", 1)
    except ValueError:
        return "unknown"
    host = rest.split("/", 1)[0].split("?", 1)[0]
    return f"{scheme}://{host}"


# Whisper defaults. Kept module-scoped for ops visibility.
_WHISPER_MODEL: str = "large-v3"
_WHISPER_DEVICE: str = "cpu"
_WHISPER_COMPUTE_TYPE: str = "int8"


class FasterWhisperTranscriber:
    """Production :class:`Transcriber` backed by ``faster-whisper``.

    - Model: ``large-v3`` at int8 CPU quantisation (the Hetzner VPS has
      no GPU; int8 trades ~5 percent WER for ~2x speed).
    - The model weights are baked into the Docker image at build time,
      so ``WhisperModel("large-v3")`` hits the local cache - never the
      network at runtime.
    - Blocking transcription runs in a thread so the event loop doesn't
      stall on 30-60 s of CPU.
    """

    def __init__(self, model_name: str = _WHISPER_MODEL) -> None:
        # Import inside __init__ so the pipeline tests that never
        # instantiate this class don't pay the (heavy) import cost
        # (CTranslate2 binary + HuggingFace tokenizers).
        # faster-whisper ships no py.typed, so the named ignore stays.
        from faster_whisper import WhisperModel  # type: ignore[import-untyped]  # no py.typed

        self._model = WhisperModel(
            model_name,
            device=_WHISPER_DEVICE,
            compute_type=_WHISPER_COMPUTE_TYPE,
        )

    async def transcribe(self, mp4_path: Path) -> str:
        logger.info("whisper transcribe start path=%s", mp4_path.name)
        try:
            text = await asyncio.to_thread(self._transcribe_sync, mp4_path)
        except (RuntimeError, OSError, ValueError) as exc:
            logger.warning("whisper transcribe failed: %s", type(exc).__name__)
            raise ExtractionError(
                "transcription_failed",
                "Audio konnte nicht transkribiert werden.",
            ) from exc
        logger.info("whisper transcribe done path=%s len=%d", mp4_path.name, len(text))
        # Content-sensitive — DEBUG only.
        logger.debug("whisper transcript (truncated): %s", text[:200])
        return text

    def _transcribe_sync(self, mp4_path: Path) -> str:
        segments, _info = self._model.transcribe(
            str(mp4_path),
            beam_size=5,
            vad_filter=True,
        )
        return " ".join(seg.text.strip() for seg in segments if seg.text).strip()


__all__ = [
    "ExtractionError",
    "ExtractionErrorCode",
    "FasterWhisperTranscriber",
    "StubDownloader",
    "StubTranscriber",
    "Transcriber",
    "VideoAssets",
    "VideoDownloader",
    "YtDlpDownloader",
]
