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
import time
from collections.abc import Callable
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
    "invalid_input",
]
"""Discriminator for :class:`ExtractionError`.

Names stay stable across slices — the .NET side (P2-5 / P2-6) branches
on them to decide retry vs user-visible error.

- ``source_unavailable`` — yt-dlp download failed (private video,
  deleted post, geo-blocked, 404). Maps to HTTP 422.
- ``transcription_failed`` — Whisper model error. Maps to HTTP 500.
- ``invalid_input`` — caller-supplied payload failed a pipeline-level
  validation rule (e.g. 0 or >10 photos for the P2-3 Vision path).
  Maps to HTTP 422. Kept on the shared ``ExtractionError`` class so
  endpoint handlers only need one ``except`` clause across slices.
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


ProgressHook = Callable[..., None]
"""Signature for intra-phase progress callbacks from downloader /
transcriber stages. Called with ``(done, total)`` plus an optional
``percent_override`` keyword (0..100). ``total`` may be ``0`` when the
stage can't compute it (e.g. unknown segment count from a lazy
iterator). When ``percent_override`` is set, the pipeline-side wrapper
uses it as ``phase_progress`` instead of computing ``done/total`` —
this lets the yt-dlp wrapper apply richer heuristics (HLS
fragment-index ratio, elapsed-time ramp) when ``total`` is unknown.

The pipeline wraps this into a
:class:`extractor.progress.ProgressEvent` before forwarding to the
.NET side.

Hooks are synchronous so yt-dlp's thread-based ``progress_hooks`` can
call them without bouncing back to the event loop. The wrapping
pipeline-side closure is what bridges to the async
:meth:`ProgressReporter.report`.
"""


@runtime_checkable
class VideoDownloader(Protocol):
    """Download a video's mp4 + metadata. Async so the pipeline is async-friendly."""

    async def download(
        self,
        *,
        url: str,
        workdir: Path,
        on_progress: ProgressHook | None = None,
    ) -> VideoAssets:
        """Fetch the video into ``workdir`` and return its assets.

        ``on_progress`` (optional) is called during download with
        ``(bytes_done, bytes_total)``. Implementations that can't
        surface byte-level progress may never call it; pipeline code
        tolerates that.

        Raises :class:`ExtractionError` (``source_unavailable``) on any
        non-transient failure (private, deleted, geo-blocked, 404).
        """
        ...


@runtime_checkable
class Transcriber(Protocol):
    """Transcribe a downloaded video's audio into plain text."""

    async def transcribe(
        self,
        mp4_path: Path,
        on_segment: ProgressHook | None = None,
    ) -> str:
        """Return a plain-text transcript. Empty string when no audio /
        no speech detected.

        ``on_segment`` (optional) is called per-segment with
        ``(segments_done, segments_total)`` where ``segments_total`` may
        be ``0`` when unknown (lazy iteration). Raises
        :class:`ExtractionError` (``transcription_failed``) on
        model-level failures."""
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

    ``progress_ticks`` (optional) lets tests drive the ``on_progress``
    hook to exercise pipeline-side reporter wiring without running a
    real yt-dlp download. Each tuple ``(done, total)`` fires one
    callback; the sequence is iterated in order right before assets
    are returned.
    """

    def __init__(
        self,
        *,
        assets: VideoAssets | None = None,
        error: ExtractionError | None = None,
        progress_ticks: list[tuple[int, int]] | None = None,
    ) -> None:
        self._assets = assets
        self._error = error
        self._progress_ticks = progress_ticks or []

    async def download(
        self,
        *,
        url: str,
        workdir: Path,
        on_progress: ProgressHook | None = None,
    ) -> VideoAssets:
        if self._error is not None:
            raise self._error
        if self._assets is None:
            raise ExtractionError(
                "source_unavailable",
                "StubDownloader was neither configured with assets nor error.",
            )
        if on_progress is not None:
            for done, total in self._progress_ticks:
                on_progress(done, total, percent_override=None)
        return self._assets


class StubTranscriber:
    """In-memory stand-in for :class:`Transcriber`.

    Default is an empty string so tests that don't care about the
    transcript can pass ``StubTranscriber()`` and still exercise the
    pipeline.

    ``segment_ticks`` (optional) lets tests drive the ``on_segment``
    hook to exercise pipeline-side reporter wiring without running a
    real Whisper model. Each tuple ``(done, total)`` fires one
    callback in order before :meth:`transcribe` returns.
    """

    def __init__(
        self,
        transcript: str = "",
        *,
        segment_ticks: list[tuple[int, int]] | None = None,
    ) -> None:
        self._transcript = transcript
        self._segment_ticks = segment_ticks or []

    async def transcribe(
        self,
        mp4_path: Path,
        on_segment: ProgressHook | None = None,
    ) -> str:
        if on_segment is not None:
            for done, total in self._segment_ticks:
                on_segment(done, total, percent_override=None)
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

    When ``on_progress`` is provided, a yt-dlp ``progress_hooks`` entry
    forwards per-chunk ``(downloaded_bytes, total_bytes)`` updates. We
    read ``total_bytes`` first and fall back to
    ``total_bytes_estimate`` because live / HLS sources only surface
    an estimate. A total of ``0`` means "unknown" — the reporter layer
    keeps bytes_total=None in that case.
    """

    async def download(
        self,
        *,
        url: str,
        workdir: Path,
        on_progress: ProgressHook | None = None,
    ) -> VideoAssets:
        logger.info("yt-dlp download start host=%s", _redact(url))
        try:
            info = await asyncio.to_thread(self._download_sync, url, workdir, on_progress)
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
    def _download_sync(
        url: str,
        workdir: Path,
        on_progress: ProgressHook | None,
    ) -> dict[str, Any]:
        """Synchronous yt-dlp call. Runs in a worker thread."""
        outtmpl = str(workdir / "%(id)s.%(ext)s")
        options: dict[str, Any] = {**_YTDLP_OPTIONS, "outtmpl": outtmpl}
        if on_progress is not None:
            options["progress_hooks"] = [
                _make_ytdlp_progress_wrapper(on_progress),
            ]
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            if info is None:
                raise DownloadError("yt-dlp returned no info for URL")
            # ``prepare_filename`` gives us the real on-disk path.
            resolved = ydl.prepare_filename(info)
        info_dict = dict(info) if isinstance(info, dict) else {}
        info_dict["_resolved_path"] = resolved
        return info_dict


def _make_ytdlp_progress_wrapper(
    on_progress: ProgressHook,
    *,
    start_time: float | None = None,
) -> Callable[[dict[str, Any]], None]:
    """Wrap a simple ``(done, total)`` hook into yt-dlp's dict-shape API.

    yt-dlp calls the returned closure with dicts like
    ``{"status": "downloading", "downloaded_bytes": 123,
    "total_bytes": 456}``. We only forward ``downloading`` events;
    ``finished`` + ``error`` are surfaced via the sync download's
    return value / raise path.

    Progress-source priority (BUG-027 — fragmented HLS / m3u8 sources
    such as Facebook / Instagram / TikTok give ``total_bytes=0`` for
    the entire download, so the byte-count fallback alone leaves the
    UI stuck at 0 % for 30-90 s):

    1. If yt-dlp surfaces ``fragment_index`` + ``fragment_count`` (HLS
       segment streams), use ``fragment_index / fragment_count`` —
       authoritative real progress.
    2. Else if ``total_bytes`` is known, use ``downloaded_bytes /
       total_bytes`` (classic mp4 path).
    3. Else if ``total_bytes_estimate`` is known, same ratio against
       the estimate.
    4. Else (total truly unknown): fall back to an elapsed-time ramp:
       ``min(95, int(elapsed_s * 3))`` so the UI sees ~3 % per
       second up to a 95 % cap. The cap means the phase never
       "completes" by itself — only the real download-finished
       transition flips to ``transcribing``.

    ``start_time`` defaults to ``time.monotonic()`` at factory-call
    time so the elapsed-ramp is measured from the moment we started
    waiting, not the first hook tick.

    Even when total is unknown the raw ``downloaded_bytes`` is still
    forwarded as ``done`` so the frontend's ``PhaseDetailCard`` can
    surface the byte counter (it already tolerates a null total).
    """
    ramp_start = start_time if start_time is not None else time.monotonic()

    def _hook(info: dict[str, Any]) -> None:
        if info.get("status") != "downloading":
            return
        done_raw = info.get("downloaded_bytes") or 0
        total_raw = info.get("total_bytes") or info.get("total_bytes_estimate") or 0
        frag_index_raw = info.get("fragment_index") or 0
        frag_count_raw = info.get("fragment_count") or 0
        try:
            done = int(done_raw)
            total = int(total_raw)
            frag_index = int(frag_index_raw)
            frag_count = int(frag_count_raw)
        except (TypeError, ValueError):
            # yt-dlp rarely hands non-numeric values; guard anyway —
            # one bad hook call shouldn't abort the download.
            return

        percent_override: int | None
        if frag_index > 0 and frag_count > 0:
            # HLS fragment progress is the most accurate signal we have
            # for FB / IG / TikTok streams.
            percent_override = max(0, min(100, int(frag_index / frag_count * 100)))
        elif total > 0:
            # Classic byte ratio — downstream _safe_percent will compute
            # this same value, but pre-computing here keeps the wrapper
            # the single source of truth for "what percent should the UI
            # show?".
            percent_override = max(0, min(100, int(done / total * 100)))
        else:
            # Total is genuinely unknown (fragmented stream without
            # fragment_count). Use an elapsed-time ramp capped at 95 %
            # so the phase never auto-completes — only the real
            # transition to transcribing flips it to 100 %.
            elapsed = max(0.0, time.monotonic() - ramp_start)
            percent_override = min(95, int(elapsed * 3))

        # The pipeline's wrapper is sync + non-raising by construction
        # (it schedules async work onto the event loop, swallowing
        # RuntimeError if the loop has gone away). If a caller hands us
        # a hook that raises, yt-dlp's own error handling takes over —
        # we deliberately do NOT broaden to ``except Exception`` here.
        on_progress(done, total, percent_override=percent_override)

    return _hook


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

    async def transcribe(
        self,
        mp4_path: Path,
        on_segment: ProgressHook | None = None,
    ) -> str:
        logger.info("whisper transcribe start path=%s", mp4_path.name)
        try:
            text = await asyncio.to_thread(self._transcribe_sync, mp4_path, on_segment)
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

    def _transcribe_sync(
        self,
        mp4_path: Path,
        on_segment: ProgressHook | None,
    ) -> str:
        """Run faster-whisper + fire the per-segment progress hook.

        Strategy for the segment-total count: faster-whisper yields
        segments lazily, so the true total isn't known until the
        stream is exhausted. For progress UX we pre-materialise the
        iterator into a list so ``total`` is known before firing the
        first hook — memory cost is negligible (≈ minutes of
        transcript text) and CPU transcription dominates wall-clock
        by orders of magnitude.
        """
        segments_iter, _info = self._model.transcribe(
            str(mp4_path),
            beam_size=5,
            vad_filter=True,
        )
        segments = list(segments_iter)
        total = len(segments)
        parts: list[str] = []
        for i, seg in enumerate(segments, start=1):
            if on_segment is not None:
                on_segment(i, total, percent_override=None)
            if seg.text:
                parts.append(seg.text.strip())
        return " ".join(parts).strip()


__all__ = [
    "ExtractionError",
    "ExtractionErrorCode",
    "FasterWhisperTranscriber",
    "ProgressHook",
    "StubDownloader",
    "StubTranscriber",
    "Transcriber",
    "VideoAssets",
    "VideoDownloader",
    "YtDlpDownloader",
]
