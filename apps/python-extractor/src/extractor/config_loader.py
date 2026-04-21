"""TTL-cached client for the .NET API's ``/api/internal/extractor-config``.

CFG-1 — hot-configurable knobs for the extractor. The .NET side (CFG-0)
owns the storage + admin UI; this module is the Python consumer. Values
live in a single table keyed by dotted strings
(``llm.structured.system_prompt``, ``feature.video_import_enabled``, …)
and are fetched as a snapshot on demand.

Contract
--------
- :meth:`ExtractorConfig.get` accepts a key + a caller-supplied default;
  on cache hit returns the typed value, otherwise refreshes the cache
  and looks up once. Misses (key absent, type mismatch, fetch failure)
  fall through to the default.
- The loader **never raises** — the pipeline always has a working
  fallback because the hardcoded-default is the second arg of every
  call. A broken config API cannot take down an import.
- Fetch failures (connect / 5xx / malformed body) log at WARNING and
  keep whatever is in the cache. Stale data is always preferred to the
  default when we HAVE stale data; the default only surfaces when the
  cache is cold.
- Thread-safety: ``asyncio.Lock`` serialises the refresh so concurrent
  ``.get`` calls can't thunder-herd the HTTP endpoint. Reads after the
  refresh release go through the normal dict lookup (fast path).

Type handling
-------------
Values land in the cache exactly as the JSON parser returns them (str /
int / float / bool / list). The ``default: T`` argument's Python type
is the type-safety anchor: when the cached value's ``type(value)`` does
not match the default's type the loader returns the default rather than
coercing. ``bool`` is a subclass of ``int`` in Python; we treat them as
distinct to avoid ``True`` silently becoming ``1`` for an ``int``-typed
key. This mirrors the same rule the rest of the post-processor uses.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, TypeVar

import httpx

logger = logging.getLogger("extractor.config_loader")

# Endpoint on the .NET side — internal-only (docker-network scoped). No
# auth headers; the .NET API enforces `InternalOnlyMiddleware` which
# rejects non-docker-network traffic at the edge.
_ENDPOINT_PATH: str = "/api/internal/extractor-config"

# Hard cap on a single fetch. The endpoint is local-network + trivial —
# 5 s is generous for a JSON-only list endpoint.
_FETCH_TIMEOUT_SECONDS: float = 5.0

T = TypeVar("T")


class ExtractorConfig:
    """TTL-cached client for the internal extractor-config endpoint.

    Usage::

        async with httpx.AsyncClient(base_url="http://api") as client:
            config = ExtractorConfig(client=client)
            prompt = await config.get("llm.structured.system_prompt", DEFAULT)
    """

    def __init__(
        self,
        *,
        client: httpx.AsyncClient,
        ttl_seconds: float = 60.0,
    ) -> None:
        """Build a loader bound to an ``httpx.AsyncClient``.

        Parameters
        ----------
        client
            Pre-built ``httpx.AsyncClient``. Its ``base_url`` must be set
            so the loader can issue ``GET {_ENDPOINT_PATH}`` without a
            full URL. Caller owns the client lifecycle (``.aclose()``).
        ttl_seconds
            Cache lifetime in seconds. The admin UI contract is 60 s; 0
            disables caching (forces a fetch on every ``get``), mostly
            useful for tests.
        """
        self._client = client
        self._ttl = ttl_seconds
        self._cache: dict[str, Any] = {}
        self._versions: dict[str, int] = {}
        self._cache_expires_at: float = 0.0
        self._have_cache: bool = False
        self._lock = asyncio.Lock()

    async def get(self, key: str, default: T) -> T:
        """Return the cached value for ``key``, refreshing if the TTL expired.

        Type-match rule: the returned value's ``type(...)`` must equal
        ``type(default)`` (modulo the ``bool``/``int`` split noted in the
        module docstring). Otherwise the caller's default wins.
        """
        async with self._lock:
            if time.monotonic() >= self._cache_expires_at:
                await self._refresh_locked()
        if key not in self._cache:
            return default
        value = self._cache[key]
        if not _type_matches(value, default):
            return default
        # ``value`` is ``Any`` at the dict level but we've just verified
        # the runtime type matches ``T``. Returning it typed-T is safe.
        return value  # type: ignore[no-any-return]

    def version_of(self, key: str) -> int | None:
        """Return the API-reported ``Version`` integer for ``key``, or ``None``.

        Used by the :data:`config_snapshot` rider so ``ResultJson`` can
        record the exact prompt version that ran.

        Returns ``None`` for unknown keys rather than ``0`` so the
        snapshot can distinguish "key missing from cache" from "v0 seed
        row" (CFG-0's migration writes ``Version=0`` on seed).
        """
        return self._versions.get(key)

    async def _refresh_locked(self) -> None:
        """Fetch + rebuild the cache. Caller must hold ``self._lock``.

        Never raises — all failures collapse to a WARNING log + leave
        the existing cache alone. The expiry timestamp is STILL bumped
        on failure so a continuously-broken API doesn't chew through
        the client side's timeout budget on every pipeline call; we
        retry at most once per TTL window.
        """
        try:
            response = await self._client.get(_ENDPOINT_PATH, timeout=_FETCH_TIMEOUT_SECONDS)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            # ``httpx.HTTPError`` covers transport + status errors;
            # ``ValueError`` covers ``response.json()`` malformed input.
            logger.warning(
                "extractor-config fetch failed err=%s have_cache=%s",
                type(exc).__name__,
                self._have_cache,
            )
            self._cache_expires_at = time.monotonic() + self._ttl
            return

        items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            logger.warning(
                "extractor-config payload malformed: expected {'items': [...]}, got type=%s",
                type(payload).__name__,
            )
            self._cache_expires_at = time.monotonic() + self._ttl
            return

        new_cache: dict[str, Any] = {}
        new_versions: dict[str, int] = {}
        for entry in items:
            if not isinstance(entry, dict):
                continue
            key = entry.get("key")
            if not isinstance(key, str) or not key:
                continue
            # ``value`` lands verbatim — JSON already parsed the type.
            new_cache[key] = entry.get("value")
            version = entry.get("version")
            if isinstance(version, int) and not isinstance(version, bool):
                new_versions[key] = version
        self._cache = new_cache
        self._versions = new_versions
        self._have_cache = True
        self._cache_expires_at = time.monotonic() + self._ttl


def _type_matches(value: Any, default: Any) -> bool:
    """Runtime type-compatibility check between a cached value + caller default.

    - ``bool`` is treated as distinct from ``int`` (avoid ``True`` →
      ``1`` surprises on an ``int``-typed key).
    - ``list`` matches any list; the caller's default fixes the element
      semantics. Element-type validation is out of scope — the CFG-0
      backend is the authoritative per-key validator.
    - Everything else: exact ``type(...) is type(...)`` match.
    """
    if isinstance(default, bool):
        return isinstance(value, bool)
    if isinstance(default, int) and not isinstance(default, bool):
        return isinstance(value, int) and not isinstance(value, bool)
    if isinstance(default, float):
        # Accept int-typed values for a float default too — JSON emits
        # ``0`` as int, not ``0.0``. Caller gets the numeric value either
        # way. Reject bool explicitly (bool ⊂ int).
        return isinstance(value, float) or (isinstance(value, int) and not isinstance(value, bool))
    if isinstance(default, str):
        return isinstance(value, str)
    if isinstance(default, list):
        return isinstance(value, list)
    # Unsupported default type — conservative: reject so the default
    # wins and nothing surprising lands in the pipeline.
    return False


async def get_flag(config: ExtractorConfig | None, key: str, default: bool) -> bool:
    """Tiny helper: ``await config.get(key, default)`` with ``None``-safety.

    Pipeline call sites pass ``config=None`` when running in a legacy /
    test context without the loader; centralising the ``None`` check
    here avoids duplicating the same 3-line helper across ``url.py`` /
    ``chat.py`` / ``photo.py``.
    """
    if config is None:
        return default
    return await config.get(key, default)


async def get_int(config: ExtractorConfig | None, key: str, default: int) -> int:
    """``config.get`` for an ``int`` key with ``None``-safety."""
    if config is None:
        return default
    return await config.get(key, default)


async def get_float(config: ExtractorConfig | None, key: str, default: float) -> float:
    """``config.get`` for a ``float`` key with ``None``-safety."""
    if config is None:
        return default
    return await config.get(key, default)


async def get_str(config: ExtractorConfig | None, key: str, default: str) -> str:
    """``config.get`` for a ``str`` key with ``None``-safety.

    Placeholder-safe: the CFG-0 migration seeds string-typed prompt
    keys with literal ``PLACEHOLDER_<KIND>_PROMPT`` strings (too short
    to satisfy the 100-char validator, but the seed bypasses that).
    If the DB still carries that placeholder (nothing has overwritten
    it yet via the admin UI), we fall back to the code default — the
    actual prompt shipped with this extractor release — so extraction
    never runs against a dummy string.
    """
    if config is None:
        return default
    value = await config.get(key, default)
    if isinstance(value, str) and value.startswith("PLACEHOLDER_"):
        return default
    return value


async def get_list(config: ExtractorConfig | None, key: str, default: list[str]) -> list[str]:
    """``config.get`` for a ``string_list`` key with ``None``-safety."""
    if config is None:
        return default
    return await config.get(key, default)


__all__ = [
    "ExtractorConfig",
    "get_flag",
    "get_float",
    "get_int",
    "get_list",
    "get_str",
]
