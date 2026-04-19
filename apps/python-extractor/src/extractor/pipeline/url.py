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

Error handling:
- Downloader raises :class:`ExtractionError` (``source_unavailable``)
  → propagates; the endpoint maps to HTTP 422.
- LLM raises :class:`LLMProviderError` → propagates unchanged; the
  endpoint maps ``provider_unavailable`` → 503.
- Blog HTTP 4xx/5xx → fall back to video-only sources with the note
  ``"Website nicht erreichbar"``.

Temp files live inside an explicit ``tempfile.TemporaryDirectory``
context manager so the mp4 is always cleaned up, even on failure.
"""

from __future__ import annotations

import json
import logging
import re
import tempfile
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

import httpx

from extractor.llm import ChatMessage, LLMProvider, TokenUsage
from extractor.pipeline.blog import (
    extract_bs4_fallback,
    extract_jsonld,
    extract_recipe_scrapers,
)
from extractor.pipeline.post_process import post_process
from extractor.pipeline.types import ExtractionResult
from extractor.pipeline.video import (
    ExtractionError,
    Transcriber,
    VideoDownloader,
    YtDlpDownloader,
)
from extractor.pipeline.video import (
    FasterWhisperTranscriber as _FasterWhisperTranscriber,  # for lazy default
)
from extractor.prompts.recipe_extraction import (
    RECIPE_SCHEMA,
    SYSTEM_PROMPT_DE,
    build_user_message,
)

logger = logging.getLogger("extractor.pipeline.url")

URLClass = Literal["video", "blog"]

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

# P2-2.1 — URL-extraction regex for captions. Deliberately simple:
# catch ``http(s)://…`` up to the next whitespace / punctuation that
# obviously terminates a URL. We don't over-sanitise — failures fall
# through to ``httpx`` later, which is already wrapped in a
# graceful-failure handler.
_URL_IN_CAPTION_RE: re.Pattern[str] = re.compile(r"https?://[^\s<>\"')\]]+", re.IGNORECASE)

# Known URL-shortener hosts. Following a shortener means following a
# redirect we can't filter (same-host / video-host checks no longer
# apply after redirect), so we skip them entirely. ``youtu.be`` is
# already covered via ``_VIDEO_HOSTS``.
_SHORTENER_HOSTS: frozenset[str] = frozenset(
    {
        "bit.ly",
        "tinyurl.com",
        "lnk.bio",
        "linktr.ee",
        "t.co",
        "ow.ly",
        "buff.ly",
    }
)


def _find_first_external_url(
    caption: str | None,
    *,
    source_url: str,
) -> str | None:
    """Return the first external recipe-blog URL from the caption, or ``None``.

    Filters out:

    - URLs pointing to the same host as ``source_url`` (don't re-crawl
      the Facebook post we started from).
    - URLs on known video hosts in :data:`_VIDEO_HOSTS` (don't recurse
      into TikTok / Instagram / YouTube from an FB caption).
    - URLs on known shorteners (we'd just follow a redirect we can't
      control — see :data:`_SHORTENER_HOSTS`).

    Trailing prose punctuation (``.,;:!?``) is trimmed before parsing
    so ``"Rezept: https://blog.example/recipe."`` yields the URL
    without the trailing full stop.

    The function is side-effect free and does NO network I/O; the
    actual fetch happens later via :func:`_run_blog_path`.
    """
    if not caption:
        return None
    try:
        source_host = (urlparse(source_url).hostname or "").lower()
    except ValueError:
        source_host = ""
    for match in _URL_IN_CAPTION_RE.finditer(caption):
        raw = match.group(0).rstrip(".,;:!?")
        try:
            host = (urlparse(raw).hostname or "").lower()
        except ValueError:
            continue
        if not host:
            continue
        if source_host and host == source_host:
            continue
        if host in _VIDEO_HOSTS:
            continue
        if host in _SHORTENER_HOSTS:
            continue
        return raw
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
    """
    kind = classify_url(url)
    logger.info("extract_from_url start host=%s kind=%s", _redact_host(url), kind)

    transcript: str | None = None
    caption: str | None = None
    blog_text: str | None = None
    thumbnail_url: str | None = None
    notes: list[str] = []

    if kind == "video":
        (transcript, caption, thumbnail_url) = await _run_video_path(
            url=url,
            downloader=downloader,
            transcriber=transcriber,
        )
        # P2-2.1 — if the caption references an external recipe blog,
        # fetch it once and attach its flattened text as another source
        # for the LLM. Ingredient quantities often live only on the
        # blog, never in the spoken audio.
        external_url = _find_first_external_url(caption, source_url=url)
        if external_url is not None:
            (blog_text, caption_thumbnail, caption_notes) = await _run_blog_path(external_url)
            notes.extend(caption_notes)
            if thumbnail_url is None and caption_thumbnail is not None:
                thumbnail_url = caption_thumbnail
            logger.info(
                "caption_blog_fetched src=%s linked=%s has_text=%s",
                _redact_host(url),
                _redact_host(external_url),
                blog_text is not None,
            )
    else:
        (blog_text, thumbnail_url, notes) = await _run_blog_path(url)

    llm_output, usage = await _run_llm_structuring(
        provider=provider,
        transcript=transcript,
        caption=caption,
        blog_text=blog_text,
        thumbnail_url=thumbnail_url,
    )

    return post_process(
        llm_output,
        original_url=url,
        fallback_thumbnail=thumbnail_url,
        extra_notes=notes,
        usage=usage,
    )


# ─────────────────────────────────────────────────────────────────────
# Video path
# ─────────────────────────────────────────────────────────────────────


async def _run_video_path(
    *,
    url: str,
    downloader: VideoDownloader | None,
    transcriber: Transcriber | None,
) -> tuple[str | None, str | None, str | None]:
    """Execute the video branch. Returns (transcript, caption, thumbnail_url)."""
    active_downloader = downloader or YtDlpDownloader()
    # FasterWhisperTranscriber is heavy; lazy-instantiate only if the
    # caller didn't pre-supply a transcriber.
    active_transcriber = transcriber or _FasterWhisperTranscriber()

    with tempfile.TemporaryDirectory(prefix="extractor-video-") as tmp:
        workdir = Path(tmp)
        assets = await active_downloader.download(url=url, workdir=workdir)
        logger.info(
            "video_downloaded host=%s title=%s",
            _redact_host(url),
            assets.title[:60],
        )
        transcript = await active_transcriber.transcribe(assets.mp4_path)
        logger.info("transcript_done host=%s len=%d", _redact_host(url), len(transcript))
        return (transcript or None, assets.description or None, assets.thumbnail_url)


# ─────────────────────────────────────────────────────────────────────
# Blog path
# ─────────────────────────────────────────────────────────────────────


async def _run_blog_path(url: str) -> tuple[str | None, str | None, list[str]]:
    """Fetch + run the three-layer extractor. Returns (blog_text, thumbnail, notes)."""
    try:
        html, fetched_thumbnail = await _fetch_blog(url)
    except httpx.HTTPError as exc:
        logger.warning("blog fetch failed host=%s err=%s", _redact_host(url), exc)
        return (None, None, ["Website nicht erreichbar"])

    blog_text = _blog_layers_to_text(url=url, html=html)
    return (blog_text, fetched_thumbnail, [])


async def _fetch_blog(url: str) -> tuple[str, str | None]:
    """GET the blog page. Returns (html, og:image or None)."""
    headers = {"user-agent": _BLOG_USER_AGENT, "accept": "text/html"}
    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=_BLOG_TIMEOUT_SECONDS,
        headers=headers,
    ) as client:
        response = await client.get(url)
    response.raise_for_status()
    thumbnail = _extract_og_image(response.text)
    return response.text, thumbnail


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
) -> tuple[dict[str, Any], TokenUsage]:
    """Compose the user message, call the provider, return parsed JSON + usage."""
    user_message = build_user_message(
        transcript=transcript,
        caption=caption,
        blog_text=blog_text,
        thumbnail_url=thumbnail_url,
    )
    messages: list[ChatMessage] = [{"role": "user", "content": user_message}]
    logger.info("llm_structuring start")
    # User content — DEBUG only.
    logger.debug("llm user_message (truncated): %s", user_message[:400])
    result, usage = await provider.extract_structured(SYSTEM_PROMPT_DE, messages, RECIPE_SCHEMA)
    logger.info("llm_structuring done keys=%d", len(result))
    return result, usage


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


__all__ = [
    "ExtractionError",
    "URLClass",
    "classify_url",
    "extract_from_url",
]
