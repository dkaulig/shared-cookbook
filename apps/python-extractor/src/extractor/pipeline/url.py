"""Top-level URL-extraction glue.

Orchestrates the four pipeline stages documented in the P2-2 plan:

1. Classify the URL (video vs. blog) from the host.
2. Run the appropriate path:
   - **Video**: :class:`VideoDownloader.download` → mp4 +
     caption/title + thumbnail, then :class:`Transcriber.transcribe`
     on the mp4. If the caption references an external recipe blog
     (P2-2.1), we additionally fetch that page once via the same
     blog-path helpers and hand the flattened text to the LLM
     alongside the transcript + caption. We skip same-host, other
     video hosts, and known URL shorteners; the first surviving
     external URL wins.
   - **Blog**: ``httpx`` GET → three-layer extractor
     (:func:`extract_jsonld` → :func:`extract_recipe_scrapers` →
     :func:`extract_bs4_fallback`).
3. Feed every source into the LLM via
   :meth:`LLMProvider.extract_structured` with :data:`RECIPE_SCHEMA`.
4. Post-process (see :func:`post_process`).

Security (P2-2.1):
- All outbound blog fetches go through :func:`_assert_safe_http_target`
  which resolves the host via :func:`socket.getaddrinfo` and rejects
  any private / loopback / link-local / reserved / metadata-endpoint
  address. The check also runs on every redirect hop (manual redirect
  loop, httpx ``follow_redirects=False``), so an attacker-controlled
  page can't 302 us to ``http://127.0.0.1/``.
- Body reads are streamed with a 2 MiB hard cap and guarded by a
  ``Content-Type`` allow-list (HTML only).
- Caption-linked blog text — which is attacker-controlled — is wrapped
  in ``<untrusted_blog>…</untrusted_blog>`` delimiters so the system
  prompt can instruct the LLM to treat it as data, not instructions.
- OG-image URLs coming from caption-linked (untrusted) blogs have
  their query + fragment stripped before being stored.

Error handling:
- Downloader raises :class:`ExtractionError` (``source_unavailable``)
  → propagates; the endpoint maps to HTTP 422.
- LLM raises :class:`LLMProviderError` → propagates unchanged; the
  endpoint maps ``provider_unavailable`` → 503.
- Blog HTTP 4xx/5xx → fall back to video-only sources with the note
  ``"Website nicht erreichbar"``.
- Blog SSRF block → fall back to video-only sources with the note
  ``"Website blockiert (SSRF-Schutz)"``.

Temp files live inside an explicit ``tempfile.TemporaryDirectory``
context manager so the mp4 is always cleaned up, even on failure.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import ipaddress
import json
import logging
import re
import socket
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any, Final, Literal
from urllib.parse import urljoin, urlparse, urlunparse

import httpx

from extractor.config_loader import (
    ExtractorConfig,
    get_flag,
    get_float,
    get_int,
    get_list,
    get_str,
)
from extractor.llm import ChatMessage, LLMProvider, TokenUsage
from extractor.pipeline.blog import (
    extract_bs4_fallback,
    extract_jsonld,
    extract_recipe_scrapers,
    flatten_jsonld_image_candidates,
)
from extractor.pipeline.post_process import (
    GENERIC_COMPONENT_LABEL_BLACKLIST_DEFAULT,
    post_process,
)
from extractor.pipeline.types import ConfigSnapshot, ExtractionResult, ExtractionSignals
from extractor.pipeline.video import (
    ExtractionError,
    FfmpegFrameExtractor,
    FrameExtractor,
    Transcriber,
    VideoDownloader,
    YtDlpDownloader,
    assemble_video_candidates,
)
from extractor.pipeline.video import (
    FasterWhisperTranscriber as _FasterWhisperTranscriber,  # for lazy default
)
from extractor.progress import NullProgressReporter, ProgressEvent, ProgressReporter
from extractor.prompts.recipe_extraction import (
    RECIPE_SCHEMA,
    SYSTEM_PROMPT_DE,
    build_user_message,
)

logger = logging.getLogger("extractor.pipeline.url")

URLClass = Literal["video", "blog"]

_HookKind = Literal["bytes", "segments"]
"""Discriminator for :func:`_make_progress_hook`.

``bytes`` → the hook wraps ``(done, total)`` into the
``bytes_done``/``bytes_total`` fields of a ``downloading``
:class:`ProgressEvent`. ``segments`` → the same pair flows into
``segments_done``/``segments_total`` on a ``transcribing`` event.
Collapsing the two hook factories into one parameterised builder
removed ~30 lines of duplicated wiring with zero behavioural drift.
"""

# Cap the reporter's retained-task list so a callback outage (or any
# scenario where ``reporter.report`` coroutines never drain) cannot
# accumulate unbounded memory. 20 is well above the typical
# burst (~5 phase-starts + ~20 throttle-limited ticks per import) but
# bounded enough that a pathologically slow .NET side is noticed via
# log drops rather than OOM.
_MAX_PENDING_TASKS: Final[int] = 20

_VIDEO_HOSTS: frozenset[str] = frozenset(
    {
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "youtu.be",
        "facebook.com",
        "www.facebook.com",
        "m.facebook.com",
        "fb.watch",
        "instagram.com",
        "www.instagram.com",
        "tiktok.com",
        "www.tiktok.com",
        "vm.tiktok.com",
    }
)

# HTTP client defaults — blog fetches are quick pages, not LLM calls,
# so a tight timeout is fine.
_BLOG_TIMEOUT_SECONDS: float = 10.0
_BLOG_USER_AGENT: str = (
    "Mozilla/5.0 (compatible; FamilienKochbuch-Extractor/0.1; +https://familien-kochbuch.example)"
)

# Security caps (P2-2.1).
_BLOG_MAX_BYTES: int = 2 * 1024 * 1024  # 2 MiB
_BLOG_MAX_REDIRECTS: int = 5  # match httpx default
_BLOG_ALLOWED_CONTENT_TYPES: tuple[str, ...] = (
    "text/html",
    "application/xhtml+xml",
)

# Hostnames that must never be fetched — cover cloud metadata
# endpoints the DNS layer may hand back a public-looking answer for
# due to split-horizon DNS.
_BLOCKED_HOSTNAMES: frozenset[str] = frozenset(
    {
        "localhost",
        "metadata",
        "metadata.google.internal",
        "metadata.azure.com",
        "metadata.packet.net",
        "instance-data",
    }
)

# P2-2.1 — URL-extraction regex for captions. Deliberately simple:
# catch ``http(s)://…`` up to the next whitespace / punctuation that
# obviously terminates a URL. We don't over-sanitise — failures fall
# through to ``httpx`` later, which is already wrapped in a
# graceful-failure handler.
_URL_IN_CAPTION_RE: re.Pattern[str] = re.compile(r"https?://[^\s<>\"')\]]+", re.IGNORECASE)

# CFG-1 — hardcoded fallbacks for the four pipeline tunables that used
# to live as ``_SHORTENER_*`` / ``_MIN_TRANSCRIPT_CHARS`` module
# constants. The live values now flow through :class:`ExtractorConfig`;
# these defaults are the 2nd arg of every ``config.get(...)`` so the
# pipeline stays functional when the config API is unreachable (docker-
# compose boot, CFG-0 not yet deployed, etc).
_SHORTENER_HOSTS_DEFAULT: Final[list[str]] = [
    "bit.ly",
    "tinyurl.com",
    "lnk.bio",
    "linktr.ee",
    "t.co",
    "ow.ly",
    "buff.ly",
    "goo.gl",
]

# BUG-033 — shortener-resolution client config. HEAD only (never GET;
# SSRF + bandwidth risks), short per-hop timeout, and a cap on the
# number of redirect hops we chase. Shorteners typically resolve in
# one hop; three allows stacked shorteners (bit.ly → tinyurl → blog).
_SHORTENER_HEAD_TIMEOUT_DEFAULT: Final[float] = 5.0
_SHORTENER_MAX_REDIRECTS_DEFAULT: Final[int] = 3

# BUG-034 — minimum characters of non-whitespace Whisper output before
# we consider the video to have produced a usable transcript. Below
# this the audio is almost certainly background babble ("hi", "uhh")
# that doesn't help the LLM; treating it as ``had_transcript=False``
# lets the signal-aware explainer tell the user "no audio" honestly.
_MIN_TRANSCRIPT_CHARS_DEFAULT: Final[int] = 20


class SsrfBlockedError(RuntimeError):
    """Raised when a URL target resolves to a private / metadata-endpoint IP.

    Also used for adjacent fetch-guard violations (content-type mismatch,
    oversize body, redirect-loop) so the caller only needs one except
    branch to map to the SSRF-block note.
    """


async def _assert_safe_http_target(
    url: str,
    *,
    allowed_private_host: str | None = None,
) -> None:
    """Resolve the URL's host and reject any result that is private,
    loopback, link-local, reserved, or a known cloud-metadata hostname.

    Uses :func:`socket.getaddrinfo` (blocking) via :func:`asyncio.to_thread`
    so the event loop stays responsive. Rejects ALL resolved addresses —
    if even one points at a private range, the call is blocked
    (defence-in-depth against DNS-rebinding where the first lookup
    returns public and a later one returns ``127.0.0.1``).

    ``allowed_private_host`` carves out an explicit exception: when the
    URL's hostname matches it exactly, the private-IP check is skipped
    (the DNS-resolvability + blocked-hostname checks still run). This
    exists for the progress-callback path where the target IS a
    docker-internal service (``api``) whose private IP is the correct
    destination by design. The pydantic layer at request-ingress already
    validates that the caller-supplied callback URL matches the env-
    configured host; this parameter simply tells the defence-in-depth
    layer about that trust chain.
    """
    try:
        parsed = urlparse(url)
    except ValueError as exc:
        raise SsrfBlockedError(f"malformed url: {exc}") from exc
    host = (parsed.hostname or "").lower()
    if not host:
        raise SsrfBlockedError("missing host")
    if host in _BLOCKED_HOSTNAMES:
        raise SsrfBlockedError(f"blocked hostname: {host}")
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None, 0, socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise SsrfBlockedError(f"dns resolution failed: {exc}") from exc
    # Trusted callback host: DNS resolved OK, skip the private-IP gate
    # because the target is supposed to be on the internal docker net.
    if allowed_private_host is not None and host == allowed_private_host.lower():
        return
    for _family, _type, _proto, _canon, sockaddr in infos:
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError as exc:
            raise SsrfBlockedError(f"invalid ip from dns: {ip_str}") from exc
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise SsrfBlockedError(f"blocked address: {host} -> {ip}")


def _safe_host(url: str) -> str:
    """Return the URL's lowercased hostname, or ``""`` on parse failure.

    Also IDNA-encodes non-ASCII hostnames (some Location headers in
    shortener redirect chains carry punycode or raw Unicode). Any
    encoding failure collapses to the empty string so the caller's
    filter loop skips the candidate.
    """
    try:
        raw_host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""
    if not raw_host:
        return ""
    try:
        # ``idna`` round-trips ASCII hosts unchanged; rejects genuinely
        # malformed Unicode / zero-width chars.
        return raw_host.encode("idna").decode("ascii")
    except (UnicodeError, UnicodeDecodeError):
        return ""


async def _resolve_shortener(
    url: str,
    *,
    client: httpx.AsyncClient,
    max_redirects: int = _SHORTENER_MAX_REDIRECTS_DEFAULT,
) -> str | None:
    """HEAD-follow a shortener URL up to ``max_redirects`` hops.

    Returns the final URL (the first hop that is NOT a 3xx with a
    ``Location``), or ``None`` if any hop fails: timeout, non-3xx error
    status, missing ``Location``, redirect loop (same host seen twice),
    SSRF-blocked target, or parse failure. Never raises — all errors
    collapse to ``None`` + a single WARNING log with just the exception
    type name (no URL body to keep logs PII-free).

    The request is HEAD-only; shorteners resolve to the Location header
    without needing the body, and HEAD keeps the SSRF + bandwidth
    surface minimal. ``follow_redirects=False`` on the client is
    assumed so we see every hop for the loop-guard.
    """
    current_url = url
    visited_hosts: set[str] = set()
    try:
        for _hop in range(max_redirects):
            # SSRF guard — reject private / metadata targets BEFORE
            # we dial, on every hop. Shorteners usually point at
            # public blogs, but a malicious link can 302 us to
            # 127.0.0.1.
            try:
                await _assert_safe_http_target(current_url)
            except SsrfBlockedError as exc:
                logger.warning(
                    "shortener_resolve_blocked host=%s err=%s",
                    _safe_host(current_url) or "unknown",
                    type(exc).__name__,
                )
                return None

            host = _safe_host(current_url)
            if not host:
                logger.warning("shortener_resolve_skipped reason=invalid_host")
                return None
            if host in visited_hosts:
                logger.warning(
                    "shortener_resolve_loop host=%s",
                    host,
                )
                return None
            visited_hosts.add(host)

            response = await client.head(current_url)
            status = response.status_code
            if 300 <= status < 400 and "location" in response.headers:
                next_url = urljoin(current_url, response.headers["location"])
                # Parse-check the next hop; a Location we can't parse
                # is a dead end.
                if not _safe_host(next_url):
                    logger.warning("shortener_resolve_skipped reason=invalid_location")
                    return None
                current_url = next_url
                continue
            if 200 <= status < 300:
                # Final resolved URL — return whatever current_url is.
                return current_url
            # 4xx / 5xx / unexpected status.
            logger.warning(
                "shortener_resolve_http_error host=%s status=%d",
                host,
                status,
            )
            return None
        # Hop cap hit without reaching a terminal response.
        logger.warning(
            "shortener_resolve_max_hops host=%s",
            _safe_host(current_url) or "unknown",
        )
        return None
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        logger.warning(
            "shortener_resolve_network_error err=%s",
            type(exc).__name__,
        )
        return None


async def _extract_caption_blog_url(
    caption: str | None,
    *,
    source_url: str,
    client: httpx.AsyncClient | None = None,
    blog_follow_enabled: bool = True,
    shortener_hosts: frozenset[str] | None = None,
    shortener_max_redirects: int = _SHORTENER_MAX_REDIRECTS_DEFAULT,
) -> str | None:
    """Return the first external recipe-blog URL from the caption, or ``None``.

    Filters out:

    - URLs pointing to the same host as ``source_url`` (don't re-crawl
      the Facebook post we started from).
    - URLs on known video hosts in :data:`_VIDEO_HOSTS` (don't recurse
      into TikTok / Instagram / YouTube from an FB caption).
    - URLs on known shorteners (``shortener_hosts``). When a ``client``
      is supplied, BUG-033 enables HEAD-resolution to the final URL and
      re-applies the same-host / video-host / shortener filters on the
      resolved target. Without a client (legacy sync callers),
      shorteners are skipped — same behaviour as before.

    CFG-1 — when ``blog_follow_enabled`` is False the whole function
    short-circuits to ``None`` (``feature.blog_follow_enabled`` kill
    switch). The admin can disable caption-blog follow without touching
    the video-import path. ``shortener_hosts`` comes from
    ``pipeline.shortener_hosts``; ``shortener_max_redirects`` from
    ``pipeline.shortener_max_redirects``.

    Trailing prose punctuation (``.,;:!?``) is trimmed before parsing
    so ``"Rezept: https://blog.example/recipe."`` yields the URL
    without the trailing full stop.

    All decisions log at INFO level (``caption_url_followed`` /
    ``caption_url_resolved`` / ``caption_url_skipped`` /
    ``caption_url_not_found``) with hosts only — caption URLs can carry
    tracking tokens and are never logged in full.
    """
    if not caption:
        return None
    if not blog_follow_enabled:
        logger.info("caption_url_skipped reason=blog_follow_disabled")
        return None
    active_shortener_hosts: frozenset[str] = (
        shortener_hosts if shortener_hosts is not None else frozenset(_SHORTENER_HOSTS_DEFAULT)
    )
    source_host = _safe_host(source_url)
    had_matches = False
    for match in _URL_IN_CAPTION_RE.finditer(caption):
        had_matches = True
        raw = match.group(0).rstrip(".,;:!?")
        host = _safe_host(raw)
        if not host:
            continue
        if source_host and host == source_host:
            logger.info(
                "caption_url_skipped reason=same_host src_host=%s",
                source_host,
            )
            continue
        if host in _VIDEO_HOSTS:
            logger.info(
                "caption_url_skipped reason=video_host src_host=%s",
                host,
            )
            continue
        if host in active_shortener_hosts:
            if client is None:
                # Legacy sync callers — behave exactly as before BUG-033.
                logger.info(
                    "caption_url_skipped reason=shortener_no_client src_host=%s",
                    host,
                )
                continue
            resolved = await _resolve_shortener(
                raw, client=client, max_redirects=shortener_max_redirects
            )
            if resolved is None:
                logger.info(
                    "caption_url_skipped reason=shortener_unresolved src_host=%s",
                    host,
                )
                continue
            resolved_host = _safe_host(resolved)
            if not resolved_host:
                logger.info(
                    "caption_url_skipped reason=shortener_invalid_resolved src_host=%s",
                    host,
                )
                continue
            if source_host and resolved_host == source_host:
                logger.info(
                    "caption_url_skipped reason=same_host_after_resolve src_host=%s target_host=%s",
                    host,
                    resolved_host,
                )
                continue
            if resolved_host in _VIDEO_HOSTS:
                logger.info(
                    "caption_url_skipped reason=video_host_after_resolve"
                    " src_host=%s target_host=%s",
                    host,
                    resolved_host,
                )
                continue
            if resolved_host in active_shortener_hosts:
                # Resolution bounced into another shortener we can't
                # follow further (max-hops cap or the resolver returned
                # a 200 Location that is itself a shortener host).
                logger.info(
                    "caption_url_skipped reason=shortener_after_resolve src_host=%s target_host=%s",
                    host,
                    resolved_host,
                )
                continue
            logger.info(
                "caption_url_resolved src_host=%s target_host=%s",
                host,
                resolved_host,
            )
            return resolved
        logger.info(
            "caption_url_followed src_host=%s target_host=%s",
            source_host or "unknown",
            host,
        )
        return raw
    if had_matches:
        # Regex matched something but every candidate was filtered —
        # useful signal for prod diagnoses.
        logger.info("caption_url_not_found reason=all_filtered")
    return None


def classify_url(url: str) -> URLClass:
    """Return ``"video"`` for known video hosts, else ``"blog"``.

    Uses the host portion of the URL only (no HEAD request). Normalises
    the host to lowercase. Unknown / unparseable URLs fall through to
    ``"blog"`` so the plain-HTML path can at least try.
    """
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return "blog"
    if host in _VIDEO_HOSTS:
        return "video"
    return "blog"


async def extract_from_url(
    url: str,
    *,
    provider: LLMProvider,
    downloader: VideoDownloader | None = None,
    transcriber: Transcriber | None = None,
    frame_extractor: FrameExtractor | None = None,
    reporter: ProgressReporter | None = None,
    config: ExtractorConfig | None = None,
) -> ExtractionResult:
    """Run the full URL → structured-recipe pipeline.

    Parameters
    ----------
    url
        Source URL — video host or blog.
    provider
        :class:`LLMProvider` for structured extraction. Usually
        ``build_provider(Settings())``; tests pass a
        :class:`MockLLMProvider`.
    downloader
        Injection point for the video downloader. Tests pass a
        :class:`StubDownloader`; production uses
        :class:`YtDlpDownloader`. Ignored on the blog path.
    transcriber
        Injection point for the whisper transcriber. Tests pass a
        :class:`StubTranscriber`; production uses
        :class:`FasterWhisperTranscriber`. Ignored on the blog path.
    reporter
        Optional :class:`ProgressReporter` for phase/progress callbacks
        to the .NET side. Defaults to a :class:`NullProgressReporter`
        which incurs zero HTTP traffic — existing tests that don't care
        about progress pass nothing.
    config
        Optional :class:`ExtractorConfig` for hot-configurable knobs
        (CFG-1). When ``None``, every ``config.get`` call falls back to
        the hardcoded defaults — tests + legacy callers stay working.
        Production wires the singleton via FastAPI dependency in
        :mod:`extractor.main`.
    """
    active_reporter: ProgressReporter = reporter or NullProgressReporter()

    # CFG-1 — fetch every live tunable ONCE at the top so a mid-run
    # TTL-expiry or refresh failure can't shift behaviour between phases.
    # The ``config is None`` branch returns the literal defaults, so
    # legacy callers + unit tests that never build a config behave
    # exactly as they always did.
    video_enabled = await get_flag(config, "feature.video_import_enabled", True)
    blog_follow_enabled = await get_flag(config, "feature.blog_follow_enabled", True)
    nutrition_enabled = await get_flag(config, "feature.nutrition_estimate_enabled", True)
    shortener_hosts = frozenset(
        await get_list(config, "pipeline.shortener_hosts", _SHORTENER_HOSTS_DEFAULT)
    )
    shortener_max_redirects = await get_int(
        config, "pipeline.shortener_max_redirects", _SHORTENER_MAX_REDIRECTS_DEFAULT
    )
    shortener_head_timeout = await get_float(
        config, "pipeline.shortener_head_timeout_seconds", _SHORTENER_HEAD_TIMEOUT_DEFAULT
    )
    min_transcript_chars = await get_int(
        config, "pipeline.min_transcript_chars", _MIN_TRANSCRIPT_CHARS_DEFAULT
    )
    component_label_max = await get_int(config, "pipeline.component_label_max", 50)
    generic_label_blacklist = await get_list(
        config,
        "pipeline.generic_label_blacklist",
        list(GENERIC_COMPONENT_LABEL_BLACKLIST_DEFAULT),
    )

    kind = classify_url(url)
    logger.info("extract_from_url start host=%s kind=%s", _redact_host(url), kind)

    transcript: str | None = None
    caption: str | None = None
    blog_text: str | None = None
    thumbnail_url: str | None = None
    # COVER-0 slice A — the ordered candidate URL list. Empty on the
    # non-URL paths (photo / chat); video path fills from yt-dlp +
    # ffmpeg; blog path fills from JSON-LD ``image``.
    candidate_thumbnails: list[str] = []
    notes: list[str] = []
    blog_text_untrusted: bool = False
    # BUG-034 — observability of the three source signals. Flipped at
    # the points where each signal becomes non-empty and later threaded
    # into ``post_process`` for the empty-reason classifier + the
    # frontend's signal-aware copy.
    had_caption_url: bool = False
    had_blog_source: bool = False
    had_transcript: bool = False

    # BUG-027: wrap the rest of the pipeline in a try/finally so the
    # heartbeat task is always cancelled even on failure. Each phase
    # (downloading / transcribing / structuring) re-starts the
    # heartbeat with the new phase name; ``start_heartbeat`` cancels
    # the previous task internally so we don't leak.
    try:
        if kind == "video":
            # CFG-1 — ``feature.video_import_enabled`` kill switch. Raise
            # BEFORE we boot yt-dlp / Whisper so a disabled feature adds
            # zero import cost. Maps to HTTP 422 in main.py.
            if not video_enabled:
                raise ExtractionError(
                    "feature_disabled",
                    "Video-Import ist aktuell deaktiviert.",
                )
            (
                transcript,
                caption,
                thumbnail_url,
                candidate_thumbnails,
            ) = await _run_video_path(
                url=url,
                downloader=downloader,
                transcriber=transcriber,
                frame_extractor=frame_extractor,
                reporter=active_reporter,
            )
            # BUG-034 — treat the transcript as a real signal only when
            # it's substantive. A 3-char "Hi" is Whisper noise and the
            # user shouldn't be told "we transcribed your video" when
            # we really got one word.
            had_transcript = bool(transcript and len(transcript.strip()) >= min_transcript_chars)
            # P2-2.1 — if the caption references an external recipe blog,
            # fetch it once and attach its flattened text as another source
            # for the LLM. Ingredient quantities often live only on the
            # blog, never in the spoken audio.
            #
            # BUG-033 — scoped httpx client for the shortener HEAD probes.
            # ``follow_redirects=False`` is load-bearing: ``_resolve_shortener``
            # inspects every hop explicitly for the loop guard + SSRF check.
            # Lives only for the duration of this extraction so we don't
            # hold sockets open longer than needed.
            async with httpx.AsyncClient(
                timeout=shortener_head_timeout,
                follow_redirects=False,
            ) as shortener_client:
                external_url = await _extract_caption_blog_url(
                    caption,
                    source_url=url,
                    client=shortener_client,
                    blog_follow_enabled=blog_follow_enabled,
                    shortener_hosts=shortener_hosts,
                    shortener_max_redirects=shortener_max_redirects,
                )
            if external_url is not None:
                # BUG-034 — a caption URL resolved through all filters;
                # the user gave us a pointer. Light the signal
                # regardless of whether the subsequent blog fetch
                # succeeds — the filtering upstream already rejected
                # non-candidates (same-host, shorteners unresolved,
                # video hosts).
                had_caption_url = True
                (
                    blog_text,
                    caption_thumbnail,
                    caption_candidates,
                    caption_notes,
                ) = await _run_blog_path(external_url, untrusted=True)
                notes.extend(caption_notes)
                if thumbnail_url is None and caption_thumbnail is not None:
                    thumbnail_url = caption_thumbnail
                # COVER-0 slice A — if the video path didn't surface any
                # candidates but the caption-linked blog carries a JSON-LD
                # ``image`` array, seed the candidate list from there.
                # Keeps the picker useful for video imports where yt-dlp
                # returned only one thumbnail and ffmpeg frames failed.
                if not candidate_thumbnails and caption_candidates:
                    candidate_thumbnails = caption_candidates
                # Caption-linked blog text is attacker-controlled → wrap it in
                # delimiter tags so the system prompt's anti-injection rule
                # applies.
                blog_text_untrusted = blog_text is not None
                had_blog_source = bool(blog_text and blog_text.strip())
                logger.info(
                    "caption_blog_fetched src=%s linked=%s has_text=%s",
                    _redact_host(url),
                    _redact_host(external_url),
                    blog_text is not None,
                )
        else:
            # CFG-1 — direct blog URL honours the blog-follow kill switch
            # too. When disabled we skip the blog fetch entirely and hand
            # the LLM nothing but the URL itself; the empty-reason
            # classifier + signal-aware copy explains the situation to
            # the user.
            if blog_follow_enabled:
                (
                    blog_text,
                    thumbnail_url,
                    candidate_thumbnails,
                    notes,
                ) = await _run_blog_path(url, untrusted=False)
                # BUG-034 — direct blog URL; the blog is the only signal
                # source (no caption, no audio) so map a non-empty fetch
                # result onto ``had_blog_source``.
                had_blog_source = bool(blog_text and blog_text.strip())
            else:
                logger.info("blog_follow_skipped reason=feature_disabled")

        # Structuring phase — an async LLM call that yields no in-flight
        # granularity, so a single "phase starts" event is enough. The
        # reporter throttle handles any no-op state if we were already in
        # this phase. Heartbeat keeps the .NET ``last_progress_at``
        # ticking during the (potentially 10-20 s) Azure call.
        await active_reporter.report(ProgressEvent(phase="structuring", phase_progress=0))
        await active_reporter.start_heartbeat("structuring")

        # CFG-1 — resolve the structured-extraction params via config.
        # The hardcoded prompt / deployment / temperature / max_tokens
        # remain as defaults so tests + cold-start pipelines stay
        # working, and admin-UI changes surface here on the next 60 s
        # TTL tick.
        system_prompt = await get_str(config, "llm.structured.system_prompt", SYSTEM_PROMPT_DE)
        temperature = await get_float(config, "llm.structured.temperature", 0.0)
        max_completion_tokens = await get_int(config, "llm.structured.max_completion_tokens", 2048)
        deployment = await get_str(config, "llm.structured.deployment", "gpt-4.1-mini")

        llm_output, usage = await _run_llm_structuring(
            provider=provider,
            transcript=transcript,
            caption=caption,
            blog_text=blog_text,
            thumbnail_url=thumbnail_url,
            blog_text_untrusted=blog_text_untrusted,
            system_prompt=system_prompt,
            temperature=temperature,
            max_completion_tokens=max_completion_tokens,
            deployment=deployment,
        )

        await active_reporter.report(ProgressEvent(phase="post_processing", phase_progress=0))
        signals: ExtractionSignals = {
            "had_caption_url": had_caption_url,
            "had_blog_source": had_blog_source,
            "had_transcript": had_transcript,
        }
        # BUG-034 — log at INFO so the signal state is grep-able when
        # diagnosing "why is the extract empty?" questions in prod. Host
        # only; never the URL itself.
        logger.info(
            "extract_from_url signals host=%s had_caption_url=%s"
            " had_blog_source=%s had_transcript=%s",
            _redact_host(url),
            had_caption_url,
            had_blog_source,
            had_transcript,
        )
        snapshot = _build_config_snapshot(
            config=config,
            system_prompt=system_prompt,
            temperature=temperature,
            max_completion_tokens=max_completion_tokens,
            deployment=deployment,
            prompt_version_key="llm.structured.system_prompt",
        )
        return post_process(
            llm_output,
            original_url=url,
            fallback_thumbnail=thumbnail_url,
            candidate_thumbnails=candidate_thumbnails,
            extra_notes=notes,
            usage=usage,
            signals=signals,
            nutrition_enabled=nutrition_enabled,
            component_label_max=component_label_max,
            generic_label_blacklist=generic_label_blacklist,
            config_snapshot=snapshot,
        )
    finally:
        # Always tear down the heartbeat — even on exception — so a
        # failed import does not leave a dangling 2 s timer running
        # against a since-completed pipeline.
        await active_reporter.stop_heartbeat()


# ─────────────────────────────────────────────────────────────────────
# Video path
# ─────────────────────────────────────────────────────────────────────


async def _run_video_path(
    *,
    url: str,
    downloader: VideoDownloader | None,
    transcriber: Transcriber | None,
    frame_extractor: FrameExtractor | None,
    reporter: ProgressReporter,
) -> tuple[str | None, str | None, str | None, list[str]]:
    """Execute the video branch.

    Returns ``(transcript, caption, thumbnail_url, candidate_thumbnails)``.

    Progress wiring:
    - Fires ``downloading`` at 0% before handing off to yt-dlp, then
      per-chunk events as yt-dlp's ``progress_hooks`` tick.
    - Fires ``transcribing`` at 0% once the download returns, then
      per-segment events during faster-whisper's iteration.

    COVER-0 slice A — after the download completes, the function also
    assembles up to 6 candidate thumbnail URLs (top-2 yt-dlp + up to
    4 ffmpeg frames). Frame extraction is best-effort: if the binary
    is missing or a frame fails, the list degrades gracefully to the
    yt-dlp thumbs only.
    """
    active_downloader = downloader or YtDlpDownloader()
    # FasterWhisperTranscriber is heavy; lazy-instantiate only if the
    # caller didn't pre-supply a transcriber.
    active_transcriber = transcriber or _FasterWhisperTranscriber()

    # Capture the running loop at hook-factory time — we are on the
    # main async loop here, before yt-dlp / Whisper hand work off to a
    # thread. The hook closures need this reference so
    # ``asyncio.run_coroutine_threadsafe`` can submit the coroutine
    # back from the worker thread. The earlier code re-discovered the
    # loop inside the closure via ``asyncio.get_event_loop_policy``
    # which is deprecated since 3.12 and fragile across test teardown.
    loop = asyncio.get_running_loop()

    with tempfile.TemporaryDirectory(prefix="extractor-video-") as tmp:
        workdir = Path(tmp)
        await reporter.report(ProgressEvent(phase="downloading", phase_progress=0))
        # BUG-027: heartbeat keeps the .NET-side ``last_progress_at``
        # field alive during fragmented HLS downloads where yt-dlp may
        # not emit a tick for tens of seconds.
        await reporter.start_heartbeat("downloading")
        download_hook = _make_progress_hook(
            reporter,
            phase="downloading",
            kind="bytes",
            loop=loop,
        )
        assets = await active_downloader.download(
            url=url, workdir=workdir, on_progress=download_hook
        )
        logger.info(
            "video_downloaded host=%s title=%s",
            _redact_host(url),
            assets.title[:60],
        )

        await reporter.report(ProgressEvent(phase="transcribing", phase_progress=0))
        # Restart the heartbeat with the new phase name — the previous
        # ``downloading`` heartbeat is implicitly cancelled by
        # :meth:`start_heartbeat`.
        await reporter.start_heartbeat("transcribing")
        transcribe_hook = _make_progress_hook(
            reporter,
            phase="transcribing",
            kind="segments",
            loop=loop,
        )
        transcript = await active_transcriber.transcribe(
            assets.mp4_path, on_segment=transcribe_hook
        )
        logger.info("transcript_done host=%s len=%d", _redact_host(url), len(transcript))

        # COVER-0 slice A — assemble the candidate list. The frame
        # extractor writes JPEGs into the same workdir that holds the
        # mp4 so they are cleaned up when the ``TemporaryDirectory``
        # context exits. Stub extractors (tests) don't write anything.
        active_frame_extractor: FrameExtractor = frame_extractor or FfmpegFrameExtractor(
            output_dir=workdir,
        )
        candidate_thumbnails = await assemble_video_candidates(
            ytdlp_thumbs=list(assets.candidate_thumbnails),
            mp4_path=assets.mp4_path,
            duration_seconds=assets.duration_seconds,
            frame_extractor=active_frame_extractor,
        )
        return (
            transcript or None,
            assets.description or None,
            assets.thumbnail_url,
            candidate_thumbnails,
        )


def _make_progress_hook(
    reporter: ProgressReporter,
    *,
    phase: str,
    kind: _HookKind,
    loop: asyncio.AbstractEventLoop,
) -> Callable[..., None]:
    """Build a sync ``(done, total, *, percent_override=None)`` hook
    that schedules async reports.

    yt-dlp + faster-whisper call progress hooks from a worker thread;
    we bridge back to the event loop via
    :func:`asyncio.run_coroutine_threadsafe`. The ``loop`` argument is
    captured at hook-factory time on the main async task (before the
    heavy lifting starts), so the closure doesn't have to re-discover
    it on every tick.

    ``kind="bytes"`` maps ``(done, total)`` to
    ``bytes_done``/``bytes_total``; ``kind="segments"`` maps the same
    pair to ``segments_done``/``segments_total``. The rest of the
    wiring is identical for both phases — collapsing the previous two
    hook factories into one builder keeps the surface small.

    ``percent_override`` (BUG-027) lets the upstream wrapper hand the
    pipeline an already-computed phase percentage — used by the yt-dlp
    wrapper to apply HLS-fragment / elapsed-time heuristics when raw
    byte totals are unknown. When unset, falls back to the classic
    ``_safe_percent(done, total)`` ratio.
    """

    def _hook(done: int, total: int, *, percent_override: int | None = None) -> None:
        if percent_override is not None:
            phase_progress = max(0, min(100, percent_override))
        else:
            phase_progress = _safe_percent(done, total)
        value = done if done > 0 else None
        total_value = total if total > 0 else None
        if kind == "bytes":
            event = ProgressEvent(
                phase=phase,
                phase_progress=phase_progress,
                bytes_done=value,
                bytes_total=total_value,
            )
        else:
            event = ProgressEvent(
                phase=phase,
                phase_progress=phase_progress,
                segments_done=value,
                segments_total=total_value,
            )
        _schedule_report(reporter, event, loop)

    return _hook


def _schedule_report(
    reporter: ProgressReporter,
    event: ProgressEvent,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Fire-and-forget scheduler for a :meth:`ProgressReporter.report` call.

    The caller is a sync closure invoked from a worker thread (yt-dlp
    / faster-whisper hand work off to a ``to_thread`` executor and
    call hooks from that thread, or from the same event-loop thread
    in the stub-driven tests). In both cases we submit via
    :func:`asyncio.run_coroutine_threadsafe` against the loop that
    was captured at hook-factory time — it is thread-safe on both
    same-thread and worker-thread callers and avoids re-discovering
    the loop via the deprecated ``get_event_loop_policy`` fallback.
    """
    try:
        future = asyncio.run_coroutine_threadsafe(reporter.report(event), loop)
    except RuntimeError:
        # Loop has closed (test teardown) — reporter is fire-and-forget
        # by design, so dropping the tick is the documented safe
        # behaviour.
        return
    _retain_task(reporter, future)


def _retain_task(
    reporter: ProgressReporter,
    future: concurrent.futures.Future[None],
) -> None:
    """Stash ``future`` on the reporter to prevent GC before it runs.

    asyncio only keeps weak refs to tasks; without a strong reference
    a fire-and-forget task can be collected before it even executes.

    The list is capped at :data:`_MAX_PENDING_TASKS` — once full, new
    entries are dropped rather than appended. That prevents unbounded
    growth if the .NET callback endpoint is wedged for the full
    duration of a long import (unlikely but possible during a deploy
    restart). Dropping the *new* (rather than the *oldest*) entry
    matches the fire-and-forget contract: losing a mid-stream tick
    degrades UX gracefully, while silently dropping the already
    in-flight tick that was about to complete wastes the round-trip
    the transport already paid for.
    """
    pending: list[Any] = getattr(reporter, "_pending_tasks", [])
    # Drop completed entries first so transient bursts don't trigger
    # the cap prematurely.
    pending[:] = [t for t in pending if not t.done()]
    if len(pending) >= _MAX_PENDING_TASKS:
        # Cap hit — drop this tick. Logged at DEBUG because the
        # pipeline's happy path doesn't ever hit it; production
        # investigation would flip the logger to DEBUG to confirm
        # backpressure.
        logger.debug(
            "progress reporter pending cap reached (%d) — dropping tick",
            _MAX_PENDING_TASKS,
        )
        return
    pending.append(future)
    # Annotated setattr — the attribute is module-private by convention.
    reporter._pending_tasks = pending  # type: ignore[attr-defined]  # reporter-internal cache


def _safe_percent(done: int, total: int) -> int:
    """Compute a 0..100 integer percentage, tolerant of ``total=0`` (unknown).

    When total is unknown we return 0 so the phase-progress stays
    anchored at the phase boundary; the .NET side still shows overall
    progress advancing between phases.
    """
    if total <= 0:
        return 0
    pct = int(done / total * 100.0)
    if pct < 0:
        return 0
    if pct > 100:
        return 100
    return pct


# ─────────────────────────────────────────────────────────────────────
# Blog path
# ─────────────────────────────────────────────────────────────────────


async def _run_blog_path(
    url: str, *, untrusted: bool
) -> tuple[str | None, str | None, list[str], list[str]]:
    """Fetch + run the three-layer extractor.

    Returns ``(blog_text, thumbnail, candidate_thumbnails, notes)``.
    ``untrusted=True`` marks the call as coming from a caption-linked
    (attacker-controlled) page — the og:image query + fragment are
    stripped before the thumbnail is returned as defence-in-depth.

    COVER-0 slice A — ``candidate_thumbnails`` carries the JSON-LD
    ``image[]`` flattened into a list[str] capped at 6. Always
    present; empty list when the page had no JSON-LD or the image
    field was missing. Slice A only returns URLs — downloading +
    SSRF enforcement lives on the .NET side in slice B.
    """
    try:
        html, fetched_thumbnail = await _fetch_blog(url)
    except SsrfBlockedError as exc:
        logger.warning("blog fetch blocked host=%s err=%s", _redact_host(url), exc)
        return (None, None, [], ["Website blockiert (SSRF-Schutz)"])
    except httpx.HTTPError as exc:
        logger.warning("blog fetch failed host=%s err=%s", _redact_host(url), exc)
        return (None, None, [], ["Website nicht erreichbar"])

    if untrusted and fetched_thumbnail is not None:
        fetched_thumbnail = _strip_query_fragment(fetched_thumbnail)

    blog_text = _blog_layers_to_text(url=url, html=html)
    # COVER-0 slice A — pull the JSON-LD ``image`` array when present.
    # We re-parse the page; :func:`extract_jsonld` is cheap (regex +
    # json.loads). Untrusted pages get their candidate URLs passed
    # through to the .NET side as-is; the backend allowlist gate runs
    # there.
    candidates: list[str] = []
    jsonld = extract_jsonld(html)
    if jsonld is not None:
        candidates = flatten_jsonld_image_candidates(jsonld)
    return (blog_text, fetched_thumbnail, candidates, [])


async def _fetch_blog(url: str) -> tuple[str, str | None]:
    """GET the blog page with SSRF + body-size + content-type guards.

    Returns ``(html, og:image or None)``. Follows up to
    :data:`_BLOG_MAX_REDIRECTS` 3xx hops manually, re-running
    :func:`_assert_safe_http_target` on every new ``Location``.
    """
    await _assert_safe_http_target(url)

    headers = {"user-agent": _BLOG_USER_AGENT, "accept": "text/html"}
    current_url = url
    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=_BLOG_TIMEOUT_SECONDS,
        headers=headers,
    ) as client:
        for hop in range(_BLOG_MAX_REDIRECTS + 1):
            async with client.stream("GET", current_url) as response:
                # Manual redirect handling — validate every hop.
                if 300 <= response.status_code < 400 and "location" in response.headers:
                    if hop >= _BLOG_MAX_REDIRECTS:
                        raise SsrfBlockedError("too many redirects")
                    next_url = urljoin(current_url, response.headers["location"])
                    await _assert_safe_http_target(next_url)
                    current_url = next_url
                    continue

                response.raise_for_status()

                content_type = response.headers.get("content-type", "").lower()
                if not any(content_type.startswith(ct) for ct in _BLOG_ALLOWED_CONTENT_TYPES):
                    raise SsrfBlockedError(f"unexpected content-type: {content_type!r}")

                buf = bytearray()
                async for chunk in response.aiter_bytes():
                    buf.extend(chunk)
                    if len(buf) > _BLOG_MAX_BYTES:
                        raise SsrfBlockedError(f"response body exceeds {_BLOG_MAX_BYTES} bytes")

                encoding = response.encoding or "utf-8"
                try:
                    html = buf.decode(encoding, errors="replace")
                except LookupError:
                    html = buf.decode("utf-8", errors="replace")
                thumbnail = _extract_og_image(html)
                return html, thumbnail

    # Unreachable: the loop either returns, raises, or exhausts via the
    # too-many-redirects branch above. This final raise exists to make
    # the control-flow total for mypy.
    raise SsrfBlockedError("redirect loop exited without response")


def _strip_query_fragment(url: str) -> str:
    """Return ``url`` with any ``?query`` + ``#fragment`` removed.

    Used for OG-image URLs pulled from caption-linked blogs — attackers
    could hide a tracking / exfil token in the query. The scheme, host,
    and path are preserved verbatim.
    """
    parsed = urlparse(url)
    return urlunparse(parsed._replace(query="", fragment=""))


def _extract_og_image(html: str) -> str | None:
    """Pull an ``og:image`` meta from HTML without parsing the whole tree.

    Regex-based for speed (BeautifulSoup already runs inside the
    fallback layer). Returns ``None`` if absent.
    """
    match = re.search(
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
        html,
        flags=re.IGNORECASE,
    )
    if match:
        return match.group(1)
    return None


def _blog_layers_to_text(*, url: str, html: str) -> str:
    """Run all three layers and flatten the best result to plain text.

    JSON-LD wins when available; then recipe-scrapers; finally BS4.
    The LLM receives a single labelled text block either way — the
    layers differ only in how much structure we can hand over.
    """
    jsonld = extract_jsonld(html)
    if jsonld is not None:
        return _format_jsonld_for_prompt(jsonld)

    scraped = extract_recipe_scrapers(url, html)
    if scraped is not None:
        return _format_scraped_for_prompt(scraped)

    return extract_bs4_fallback(html)


def _format_jsonld_for_prompt(jsonld: dict[str, Any]) -> str:
    """Render a schema.org Recipe dict into a German-labelled text block.

    We don't hand the LLM the raw JSON — labelled prose keeps the
    prompt shorter and cleaner to parse.
    """
    parts: list[str] = []
    name = jsonld.get("name")
    if isinstance(name, str):
        parts.append(f"Titel: {name}")
    description = jsonld.get("description")
    if isinstance(description, str):
        parts.append(f"Beschreibung: {description}")
    yield_ = jsonld.get("recipeYield")
    if yield_:
        parts.append(f"Portionen: {yield_}")
    prep = jsonld.get("prepTime")
    if prep:
        parts.append(f"Vorbereitungszeit: {prep}")
    cook = jsonld.get("cookTime")
    if cook:
        parts.append(f"Kochzeit: {cook}")
    ingredients = jsonld.get("recipeIngredient")
    if isinstance(ingredients, list):
        lines = [str(i) for i in ingredients if isinstance(i, str)]
        if lines:
            parts.append("Zutaten:\n- " + "\n- ".join(lines))
    instructions = jsonld.get("recipeInstructions")
    instruction_text = _flatten_instructions(instructions)
    if instruction_text:
        parts.append(f"Anleitung:\n{instruction_text}")
    keywords = jsonld.get("keywords")
    if isinstance(keywords, str):
        parts.append(f"Stichwörter: {keywords}")
    if not parts:
        # Nothing structured worth extracting — dump the JSON so the
        # LLM at least has something to work with.
        return json.dumps(jsonld, ensure_ascii=False)
    return "\n\n".join(parts)


def _flatten_instructions(raw: Any) -> str:
    """schema.org allows instructions as string, list[str], or list[HowToStep]."""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list):
        lines: list[str] = []
        for entry in raw:
            if isinstance(entry, str):
                lines.append(entry)
            elif isinstance(entry, dict):
                text = entry.get("text")
                if isinstance(text, str):
                    lines.append(text)
        return "\n".join(lines)
    return ""


def _format_scraped_for_prompt(scraped: dict[str, Any]) -> str:
    """Render the recipe-scrapers flattened dict into a labelled text block."""
    parts: list[str] = []
    if scraped.get("title"):
        parts.append(f"Titel: {scraped['title']}")
    if scraped.get("description"):
        parts.append(f"Beschreibung: {scraped['description']}")
    if scraped.get("yields"):
        parts.append(f"Portionen: {scraped['yields']}")
    if scraped.get("total_time"):
        parts.append(f"Gesamtzeit: {scraped['total_time']} min")
    ingredients = scraped.get("ingredients")
    if isinstance(ingredients, list) and ingredients:
        parts.append("Zutaten:\n- " + "\n- ".join(str(i) for i in ingredients))
    instructions = scraped.get("instructions")
    if instructions:
        parts.append(f"Anleitung:\n{instructions}")
    return "\n\n".join(parts)


# ─────────────────────────────────────────────────────────────────────
# LLM call
# ─────────────────────────────────────────────────────────────────────


async def _run_llm_structuring(
    *,
    provider: LLMProvider,
    transcript: str | None,
    caption: str | None,
    blog_text: str | None,
    thumbnail_url: str | None,
    blog_text_untrusted: bool = False,
    system_prompt: str = SYSTEM_PROMPT_DE,
    temperature: float = 0.0,
    max_completion_tokens: int = 2048,
    deployment: str | None = None,
) -> tuple[dict[str, Any], TokenUsage]:
    """Compose the user message, call the provider, return parsed JSON + usage.

    When ``blog_text_untrusted`` is True, the blog text is wrapped in
    ``<untrusted_blog>…</untrusted_blog>`` delimiters so the system
    prompt's anti-prompt-injection rule applies. Only the caption-linked
    branch sets this flag; user-typed blog URLs are trusted.

    CFG-1 — ``system_prompt``, ``temperature``, ``max_completion_tokens``
    and ``deployment`` are fetched from config by the caller and passed
    through to the provider. Non-``AzureOpenAIProvider`` implementations
    (``MockLLMProvider``, ``NullProvider``) accept the base signature
    only; the extra kwargs land via ``_call_extract_structured`` which
    forwards them on Azure and drops them on the mock.
    """
    effective_blog_text: str | None = blog_text
    if blog_text_untrusted and blog_text is not None:
        effective_blog_text = f"<untrusted_blog>\n{blog_text}\n</untrusted_blog>"
    user_message = build_user_message(
        transcript=transcript,
        caption=caption,
        blog_text=effective_blog_text,
        thumbnail_url=thumbnail_url,
    )
    messages: list[ChatMessage] = [{"role": "user", "content": user_message}]
    logger.info("llm_structuring start")
    # User content — DEBUG only.
    logger.debug("llm user_message (truncated): %s", user_message[:400])
    result, usage = await _call_extract_structured(
        provider,
        system_prompt=system_prompt,
        messages=messages,
        json_schema=RECIPE_SCHEMA,
        temperature=temperature,
        max_completion_tokens=max_completion_tokens,
        deployment=deployment,
    )
    logger.info("llm_structuring done keys=%d", len(result))
    return result, usage


async def _call_extract_structured(
    provider: LLMProvider,
    *,
    system_prompt: str,
    messages: list[ChatMessage],
    json_schema: dict[str, Any],
    temperature: float,
    max_completion_tokens: int,
    deployment: str | None,
) -> tuple[dict[str, Any], TokenUsage]:
    """Bridge the generic :class:`LLMProvider` API with Azure-specific overrides.

    :class:`AzureOpenAIProvider.extract_structured` accepts optional
    ``temperature`` / ``max_completion_tokens`` / ``deployment`` kwargs
    (CFG-1); the mock / null providers don't. Detect the capability via
    ``getattr`` on the class's signature rather than isinstance-check so
    future provider implementations can opt in by adding the kwarg.
    """
    # Late import to avoid a cycle — ``llm.azure_openai`` imports nothing
    # from this module but the factory chain does.
    from extractor.llm.azure_openai import AzureOpenAIProvider

    if isinstance(provider, AzureOpenAIProvider):
        return await provider.extract_structured(
            system_prompt,
            messages,
            json_schema,
            temperature=temperature,
            max_completion_tokens=max_completion_tokens,
            deployment=deployment,
        )
    return await provider.extract_structured(system_prompt, messages, json_schema)


# ─────────────────────────────────────────────────────────────────────
# Misc
# ─────────────────────────────────────────────────────────────────────


def _redact_host(url: str) -> str:
    """Pull just ``scheme://host`` out for log lines."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return "unknown"
    host = (parsed.hostname or "unknown").lower()
    scheme = parsed.scheme or "https"
    return f"{scheme}://{host}"


def _build_config_snapshot(
    *,
    config: ExtractorConfig | None,
    system_prompt: str,
    temperature: float,
    max_completion_tokens: int,
    deployment: str,
    prompt_version_key: str,
) -> ConfigSnapshot:
    """Build a :class:`ConfigSnapshot` for the active extraction.

    Hash is SHA-256 of the prompt string, truncated to the first 16 hex
    chars for compactness. ``prompt_version`` comes from the loader's
    version-table (falls back to ``None`` when the cache is cold).
    """
    prompt_hash = hashlib.sha256(system_prompt.encode("utf-8")).hexdigest()[:16]
    prompt_version: int | None = None
    if config is not None:
        prompt_version = config.version_of(prompt_version_key)
    return {
        "prompt_hash": f"sha256:{prompt_hash}",
        "temperature": temperature,
        "max_completion_tokens": max_completion_tokens,
        "deployment": deployment,
        "prompt_version": prompt_version,
    }


__all__ = [
    "ExtractionError",
    "SsrfBlockedError",
    "URLClass",
    "_assert_safe_http_target",
    "classify_url",
    "extract_from_url",
]
