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
import contextlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Literal, Protocol, runtime_checkable

# yt-dlp ships no stubs; module-level named ignore with a reason is the
# sanctioned pattern. Do NOT broaden to ``ignore_errors`` — we still
# want type-checking for our own wrapper code.
import yt_dlp  # type: ignore[import-untyped]  # no py.typed marker upstream
from yt_dlp.utils import DownloadError  # type: ignore[import-untyped]  # no py.typed

logger = logging.getLogger("extractor.pipeline.video")

# COVER-0 slice A — caps that keep the candidate pipeline bounded.
# - The overall cap mirrors the 3x2 grid UX (up to 6 tiles).
# - The yt-dlp cap is "top 2 by resolution"; the rest of the 6 come
#   from the ffmpeg frame extractor at [15, 35, 60, 85] %.
# - The dedupe window collapses a yt-dlp thumb and a ffmpeg frame that
#   land on effectively the same moment in the video.
_COVER_CANDIDATE_CAP: Final[int] = 6
_COVER_YTDLP_CAP: Final[int] = 2
_COVER_FRAME_PERCENTS: Final[tuple[float, ...]] = (0.15, 0.35, 0.60, 0.85)
_COVER_DEDUPE_WINDOW_SECONDS: Final[float] = 0.5
# ffmpeg emits JPEG at 1280-wide max (design §"Video imports"). Height
# stays a multiple of 2 so libx264 / libjpeg don't complain.
_COVER_FFMPEG_SCALE: Final[str] = "scale='min(1280,iw)':'-2'"

ExtractionErrorCode = Literal[
    "source_unavailable",
    "transcription_failed",
    "invalid_input",
    "feature_disabled",
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
- ``feature_disabled`` — CFG-1: the admin turned the feature off via
  the extractor-config admin UI. Maps to HTTP 422 with the German
  message the pipeline emitted, which the frontend renders verbatim.
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
class YtDlpThumbnail:
    """COVER-0 slice A — one candidate thumbnail surfaced by yt-dlp.

    - ``url`` — remote URL the extractor will hand to the .NET side for
      slice B's downloader.
    - ``width`` — yt-dlp's ``width`` metadata when present, else
      ``None``. Used to rank candidates top-by-resolution.
    - ``timestamp`` — some yt-dlp extractors (notably IG, TikTok) tag
      individual thumbnails with a ``t`` or ``time`` key pointing at
      the frame they were sampled from. When present, the candidate
      assembler uses this to dedupe against ffmpeg frames.
    """

    url: str
    width: int | None
    timestamp: float | None


@dataclass(frozen=True, slots=True)
class ThumbnailCandidate:
    """COVER-0 slice A — one ffmpeg-extracted frame candidate.

    - ``url`` — locally-addressable reference to the extracted JPEG.
      Slice A currently returns ``file://`` paths relative to a temp
      workdir; slice B will rewrite these into signed upload URLs
      through the existing :class:`IPhotoStorage` pipeline.
    - ``timestamp`` — the wall-clock second in the source video the
      frame was sampled from (used for yt-dlp-vs-ffmpeg dedupe).
    """

    url: str
    timestamp: float


@dataclass(frozen=True, slots=True)
class VideoAssets:
    """What a downloader hands back to the pipeline.

    - ``mp4_path`` — path to the downloaded file. Caller owns the
      surrounding ``tempfile.TemporaryDirectory`` and cleans up after.
    - ``title`` / ``description`` — yt-dlp metadata. ``title`` is
      always a string (empty if unknown); ``description`` may be empty.
    - ``thumbnail_url`` — ``None`` when yt-dlp didn't surface one.
      **Slice A — purely additive.** Kept alongside
      :attr:`candidate_thumbnails` until slice B retires the
      single-thumbnail attacher.
    - ``candidate_thumbnails`` — ordered, up to 2 yt-dlp thumbs from
      the ``info_dict``. ``[0]`` is the highest-resolution thumb.
      Frame extraction happens in a separate pass (see
      :func:`assemble_video_candidates`) so the downloader protocol
      stays I/O-only.
    - ``duration_seconds`` — ``info_dict['duration']`` when yt-dlp
      surfaced it. ``0.0`` means "unknown" and the frame-extraction
      pass is skipped (it needs a duration to compute percent
      timestamps).
    """

    mp4_path: Path
    title: str
    description: str
    thumbnail_url: str | None
    candidate_thumbnails: tuple[YtDlpThumbnail, ...] = ()
    duration_seconds: float = 0.0


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
class FrameExtractor(Protocol):
    """COVER-0 slice A — pull N frames out of a downloaded video.

    The protocol is narrow on purpose: the caller supplies a list of
    absolute-second timestamps (``[3.0, 7.0, 12.0, 17.0]`` for a
    20-second video at the design's 15 / 35 / 60 / 85 % marks) and
    gets back a list of :class:`ThumbnailCandidate` carrying local
    file URLs + the timestamps that actually produced a frame. A
    partial result (fewer frames than requested timestamps) is
    acceptable — the pipeline tolerates that gracefully.

    Implementations:
    - :class:`FfmpegFrameExtractor` — production, shells out to
      ``ffmpeg`` via ``asyncio.create_subprocess_exec`` (argv list, no
      shell string — command-injection safe).
    - :class:`StubFrameExtractor` — in-memory stand-in for tests; no
      filesystem or subprocess interaction.
    """

    async def extract(
        self, *, mp4_path: Path, timestamps: list[float]
    ) -> list[ThumbnailCandidate]: ...


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


class StubFrameExtractor:
    """COVER-0 slice A — in-memory :class:`FrameExtractor` for tests.

    Construct with a canned list of :class:`ThumbnailCandidate` and
    :meth:`extract` returns that list verbatim regardless of the
    requested timestamps. Keeps tests free of any real ffmpeg / disk
    I/O.
    """

    def __init__(self, *, frames: list[ThumbnailCandidate]) -> None:
        self._frames = frames

    async def extract(self, *, mp4_path: Path, timestamps: list[float]) -> list[ThumbnailCandidate]:
        return list(self._frames)


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
        duration_raw = info.get("duration")
        duration_seconds: float = 0.0
        if isinstance(duration_raw, (int, float)) and not isinstance(duration_raw, bool):
            duration_seconds = float(duration_raw)
        assets = VideoAssets(
            mp4_path=mp4_path,
            title=str(info.get("title") or ""),
            description=str(info.get("description") or ""),
            thumbnail_url=_first_thumbnail_url(info),
            candidate_thumbnails=tuple(collect_ytdlp_thumbnails(info)),
            duration_seconds=duration_seconds,
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
    4. Else (total truly unknown): forward ``downloaded_bytes`` with
       ``total=0`` and ``percent_override=None``. The heartbeat layer
       (see :class:`extractor.progress.ProgressReporter` — BUG-031)
       supplies the elapsed-time ramp so the UI still sees motion on
       silent single-blob downloads (short FB reels that never tick).

    Even when total is unknown the raw ``downloaded_bytes`` is still
    forwarded as ``done`` so the frontend's ``PhaseDetailCard`` can
    surface the byte counter (it already tolerates a null total).
    """

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
            # Total is genuinely unknown. Forward the raw byte count and
            # let the heartbeat's elapsed-time ramp (BUG-031) drive the
            # UI. Keeping the ramp in the heartbeat layer means it also
            # fires for short-blob downloads where yt-dlp never calls
            # this hook at all.
            percent_override = None

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
    - The model weights live in a named docker volume mounted at
      ``$HF_HOME`` (see docker-compose*.yml). First container boot
      streams the ~3 GB download from HuggingFace; every subsequent
      start hits the volume cache. ``main.py`` kicks off a background
      prefetch on startup so the first real transcribe isn't blocked.
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


# ─────────────────────────────────────────────────────────────────────
# COVER-0 slice A — candidate-thumbnail pipeline.
# ─────────────────────────────────────────────────────────────────────


def collect_ytdlp_thumbnails(info: dict[str, Any]) -> list[YtDlpThumbnail]:
    """Flatten yt-dlp's ``info_dict['thumbnails']`` into a rich list.

    yt-dlp gives us an array of dicts that usually look like
    ``{"url": "...", "width": 720, "height": 405, "id": "0"}``. Some
    extractors tag entries with ``"t"`` or ``"time"`` when the thumb
    corresponds to a specific frame in the video; we preserve that so
    the candidate-assembly pass can dedupe against ffmpeg frames.

    Invalid entries (non-dict, missing ``url``) are dropped silently.
    Empty return list is valid — the caller falls back to the legacy
    single-thumbnail behaviour.
    """
    thumbnails = info.get("thumbnails")
    out: list[YtDlpThumbnail] = []
    if not isinstance(thumbnails, list):
        return out
    for entry in thumbnails:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        if not isinstance(url, str) or not url:
            continue
        width_raw = entry.get("width")
        width: int | None
        width = (
            width_raw if isinstance(width_raw, int) and not isinstance(width_raw, bool) else None
        )
        # Two keys show up in the wild: ``t`` (IG) and ``time`` (FB).
        ts_raw = entry.get("t") if "t" in entry else entry.get("time")
        timestamp: float | None
        if isinstance(ts_raw, (int, float)) and not isinstance(ts_raw, bool):
            timestamp = float(ts_raw)
        else:
            timestamp = None
        out.append(YtDlpThumbnail(url=url, width=width, timestamp=timestamp))
    return out


def _compute_frame_timestamps(duration_seconds: float) -> list[float]:
    """Return the wall-clock seconds at the design's 15/35/60/85 % marks.

    Returns ``[]`` when ``duration_seconds`` is 0 / negative — we can't
    compute percentages without a known duration, and ffmpeg would seek
    to 0 for every request.
    """
    if duration_seconds <= 0:
        return []
    return [round(duration_seconds * pct, 2) for pct in _COVER_FRAME_PERCENTS]


def _top_ytdlp_urls(thumbs: list[YtDlpThumbnail]) -> list[YtDlpThumbnail]:
    """Rank yt-dlp thumbnails top-by-width, descending.

    When every thumb has ``width=None`` the sort is stable on a
    constant key, so we reverse the input first — yt-dlp documents
    the ``thumbnails`` list as worst-to-best, meaning the last entry
    is the highest quality when no metadata tells us otherwise.

    Returns the top :data:`_COVER_YTDLP_CAP` entries.
    """
    if not thumbs:
        return []
    # Reverse first so that ties (all None, or same-width) fall out in
    # yt-dlp-convention order (best first). Sort is stable, so
    # explicit widths still win.
    ranked = sorted(
        reversed(thumbs),
        key=lambda t: (t.width is None, -(t.width or 0)),
    )
    return ranked[:_COVER_YTDLP_CAP]


def _deduped_frames(
    ytdlp: list[YtDlpThumbnail],
    frames: list[ThumbnailCandidate],
) -> list[ThumbnailCandidate]:
    """Drop any ffmpeg frame within the dedupe window of a yt-dlp thumb.

    The yt-dlp entry wins because it's already hosted on a CDN —
    cheaper to render than a locally-extracted JPEG. When the yt-dlp
    thumbnail has no timestamp metadata, the dedupe guard can't fire
    for that pair and every frame passes through.
    """
    ytdlp_timestamps = [t.timestamp for t in ytdlp if t.timestamp is not None]
    if not ytdlp_timestamps:
        return list(frames)
    kept: list[ThumbnailCandidate] = []
    for frame in frames:
        if any(
            abs(frame.timestamp - ts) <= _COVER_DEDUPE_WINDOW_SECONDS for ts in ytdlp_timestamps
        ):
            continue
        kept.append(frame)
    return kept


async def _await_frames(
    *, frame_extractor: FrameExtractor, mp4_path: Path, timestamps: list[float]
) -> list[ThumbnailCandidate]:
    """Invoke the protocol and swallow any exception as a partial result.

    Frame extraction is best-effort. A thrown exception (ffmpeg
    missing, invalid video, permission error) degrades the pipeline
    to the yt-dlp thumbs only — nothing surfaces as a pipeline-fatal
    error.
    """
    if not timestamps:
        return []
    try:
        return await frame_extractor.extract(mp4_path=mp4_path, timestamps=timestamps)
    except Exception as exc:
        # Best-effort degradation: any extractor failure (missing
        # ffmpeg binary, invalid video, permission error) yields a
        # partial candidate list rather than failing the whole pipeline.
        logger.warning(
            "ffmpeg frame extraction failed — degrading to yt-dlp-only candidates: %s",
            type(exc).__name__,
        )
        return []


async def assemble_video_candidates(
    *,
    ytdlp_thumbs: list[YtDlpThumbnail],
    mp4_path: Path,
    duration_seconds: float,
    frame_extractor: FrameExtractor,
) -> list[str]:
    """Merge yt-dlp thumbs + ffmpeg frames into the final URL list.

    Pipeline:

    1. Rank ``ytdlp_thumbs`` top-by-resolution, keep the top
       :data:`_COVER_YTDLP_CAP`.
    2. Compute the 15/35/60/85 % timestamps for ``duration_seconds``.
       When the duration is unknown (0 / negative), skip frame
       extraction entirely and return just the yt-dlp URLs.
    3. Invoke ``frame_extractor.extract`` with the timestamps. Any
       exception is caught and logged — frame extraction is
       best-effort, never pipeline-fatal.
    4. Drop frames within :data:`_COVER_DEDUPE_WINDOW_SECONDS` of a
       yt-dlp timestamp (yt-dlp wins).
    5. Concatenate yt-dlp URLs + surviving frame URLs, cap at
       :data:`_COVER_CANDIDATE_CAP`.

    Returns a ``list[str]`` of absolute URLs or ``file://`` paths
    ordered so that ``[0]`` is the default cover.
    """
    top_ytdlp = _top_ytdlp_urls(ytdlp_thumbs)
    timestamps = _compute_frame_timestamps(duration_seconds)
    frames = await _await_frames(
        frame_extractor=frame_extractor,
        mp4_path=mp4_path,
        timestamps=timestamps,
    )
    frames = _deduped_frames(ytdlp_thumbs, frames)
    urls: list[str] = [t.url for t in top_ytdlp] + [f.url for f in frames]
    return urls[:_COVER_CANDIDATE_CAP]


class FfmpegFrameExtractor:
    """Production :class:`FrameExtractor` backed by the ``ffmpeg`` binary.

    For each requested timestamp, we spawn a one-shot ``ffmpeg`` call
    via :func:`asyncio.create_subprocess_exec`. The binary lives on
    PATH inside the docker image (see Dockerfile's apt install); local
    dev without the binary can swap in :class:`StubFrameExtractor`.

    COVER-0 fix: frames land at ``output_dir/<idx>.jpg`` and the
    resulting :class:`ThumbnailCandidate.url` is an HTTP URL of the
    shape ``<url_base>/<idx>.jpg``. The caller (extract_from_url)
    allocates the directory + url_base via :class:`FrameStore`, and
    the main.py FastAPI app serves the files from that path so the
    .NET :class:`CandidateAttacher` can fetch them as normal HTTP
    GETs. The filename pattern matches the endpoint's regex
    (``\\d+\\.jpg``).

    Security:
    - ``create_subprocess_exec`` receives an argv list — no shell
      interpretation. A hostile filename cannot break out of ``-i``
      into a separate command.
    - Output files live inside ``output_dir`` (caller-owned), never
      overlap with the mp4 input, and use a fixed ``<idx>.jpg``
      naming scheme — no per-input filename concatenation.
    - ``url_base`` is composed at construction time from the
      pipeline's allocated UUID dir; we never interpolate request-
      controlled data into it.
    """

    def __init__(self, *, output_dir: Path, url_base: str) -> None:
        self._output_dir = output_dir
        # Normalise by stripping a trailing slash so the join below is
        # a single ``/`` regardless of caller style.
        self._url_base = url_base.rstrip("/")

    async def extract(self, *, mp4_path: Path, timestamps: list[float]) -> list[ThumbnailCandidate]:
        results: list[ThumbnailCandidate] = []
        for index, timestamp in enumerate(timestamps):
            out_path = self._output_dir / f"{index}.jpg"
            argv: list[str] = [
                "ffmpeg",
                "-nostdin",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                f"{timestamp:.3f}",
                "-i",
                str(mp4_path),
                "-vframes",
                "1",
                "-vf",
                _COVER_FFMPEG_SCALE,
                str(out_path),
            ]
            try:
                proc = await asyncio.create_subprocess_exec(
                    *argv,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
                _stdout, stderr = await proc.communicate()
            except (OSError, ValueError) as exc:
                # ffmpeg not on PATH, invalid timestamp format, etc.
                logger.warning("ffmpeg spawn failed idx=%d err=%s", index, type(exc).__name__)
                continue
            if proc.returncode != 0 or not out_path.exists():
                logger.warning(
                    "ffmpeg frame idx=%d rc=%s stderr=%s",
                    index,
                    proc.returncode,
                    (stderr or b"")[:200].decode("utf-8", errors="replace"),
                )
                # Clean up any partial file ffmpeg may have left behind.
                if out_path.exists():
                    with contextlib.suppress(OSError):
                        out_path.unlink()
                continue
            results.append(
                ThumbnailCandidate(
                    url=f"{self._url_base}/{index}.jpg",
                    timestamp=timestamp,
                ),
            )
        return results


__all__ = [
    "ExtractionError",
    "ExtractionErrorCode",
    "FasterWhisperTranscriber",
    "FfmpegFrameExtractor",
    "FrameExtractor",
    "ProgressHook",
    "StubDownloader",
    "StubFrameExtractor",
    "StubTranscriber",
    "ThumbnailCandidate",
    "Transcriber",
    "VideoAssets",
    "VideoDownloader",
    "YtDlpDownloader",
    "YtDlpThumbnail",
    "assemble_video_candidates",
    "collect_ytdlp_thumbnails",
]
