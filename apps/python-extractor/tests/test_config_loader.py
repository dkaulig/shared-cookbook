"""Tests for :mod:`extractor.config_loader`.

CFG-1 — TTL cache + fallback semantics. The loader pulls keyed values
from the .NET API's ``/api/internal/extractor-config`` endpoint and
caches them for ``ttl_seconds``. A failed fetch MUST keep the pipeline
alive — callers pass a default, the loader returns it on miss or
fetch-fail, and never raises.

The tests run against an injectable ``httpx.MockTransport`` (not respx)
so we can count call counts cheaply + exercise the race-safety path
without fighting a shared test client.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from extractor.config_loader import ExtractorConfig


def _payload(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Build the DTO shape CFG-0 ships (``{"items": [...]}``)."""
    return {"items": items}


def _entry(key: str, value: Any, *, type_: str = "string", version: int = 1) -> dict[str, Any]:
    """One config row in the CFG-0 wire shape."""
    return {
        "key": key,
        "value": value,
        "type": type_,
        "version": version,
    }


def _make_transport(
    responses: list[httpx.Response],
    *,
    on_request: Callable[[httpx.Request], None] | None = None,
) -> httpx.MockTransport:
    """Serve each queued response in order; subsequent calls re-use the last."""
    idx = {"i": 0}

    def _handler(request: httpx.Request) -> httpx.Response:
        if on_request is not None:
            on_request(request)
        i = min(idx["i"], len(responses) - 1)
        idx["i"] += 1
        return responses[i]

    return httpx.MockTransport(_handler)


async def _build_client(transport: httpx.MockTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=transport, base_url="http://api.test")


async def test_returns_default_when_cache_empty_and_fetch_fails(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A broken API must not break the pipeline.

    First call: fetch raises → cache stays empty → caller's default
    surfaces. Loader logs WARN, never raises.
    """

    def _boom(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    transport = httpx.MockTransport(_boom)
    async with httpx.AsyncClient(transport=transport, base_url="http://api.test") as client:
        config = ExtractorConfig(client=client, ttl_seconds=60.0)
        with caplog.at_level(logging.WARNING, logger="extractor.config_loader"):
            value = await config.get("llm.structured.temperature", 0.42)
    assert value == 0.42
    # WARN-level log records the failure for ops visibility.
    assert any(
        record.levelno == logging.WARNING and "extractor-config" in record.message
        for record in caplog.records
    ), caplog.records


async def test_cached_hit_returns_api_value() -> None:
    """Happy path — key present in payload, caller's default ignored."""
    response = httpx.Response(
        200,
        json=_payload([_entry("llm.structured.temperature", 0.7, type_="float")]),
    )
    transport = _make_transport([response])
    async with await _build_client(transport) as client:
        config = ExtractorConfig(client=client, ttl_seconds=60.0)
        value = await config.get("llm.structured.temperature", 0.0)
    assert value == 0.7


async def test_cache_miss_returns_default() -> None:
    """Key not in API payload → caller's default surfaces."""
    response = httpx.Response(200, json=_payload([_entry("other.key", "x")]))
    transport = _make_transport([response])
    async with await _build_client(transport) as client:
        config = ExtractorConfig(client=client, ttl_seconds=60.0)
        value = await config.get("llm.structured.temperature", 0.123)
    assert value == 0.123


async def test_ttl_reuses_cache_within_window() -> None:
    """Inside the TTL window the loader must not hit the API twice."""
    call_count = {"n": 0}

    def _on_request(_request: httpx.Request) -> None:
        call_count["n"] += 1

    response = httpx.Response(
        200, json=_payload([_entry("llm.structured.temperature", 0.5, type_="float")])
    )
    transport = _make_transport([response], on_request=_on_request)
    async with await _build_client(transport) as client:
        config = ExtractorConfig(client=client, ttl_seconds=60.0)
        await config.get("llm.structured.temperature", 0.0)
        await config.get("llm.structured.temperature", 0.0)
        await config.get("llm.structured.temperature", 0.0)
    assert call_count["n"] == 1


async def test_ttl_refreshes_after_expiry() -> None:
    """Past the TTL the loader refreshes — picking up an updated value."""
    call_count = {"n": 0}

    def _on_request(_request: httpx.Request) -> None:
        call_count["n"] += 1

    # First response: temperature=0.1. Second: temperature=0.9.
    first = httpx.Response(
        200, json=_payload([_entry("llm.structured.temperature", 0.1, type_="float")])
    )
    second = httpx.Response(
        200, json=_payload([_entry("llm.structured.temperature", 0.9, type_="float")])
    )
    transport = _make_transport([first, second], on_request=_on_request)
    async with await _build_client(transport) as client:
        config = ExtractorConfig(client=client, ttl_seconds=0.0)  # immediate expiry
        v1 = await config.get("llm.structured.temperature", 0.0)
        v2 = await config.get("llm.structured.temperature", 0.0)
    assert v1 == 0.1
    assert v2 == 0.9
    assert call_count["n"] == 2


async def test_fetch_failure_keeps_stale_cache(caplog: pytest.LogCaptureFixture) -> None:
    """After a successful fetch a later failure must NOT blow the cache away."""
    call_count = {"n": 0}

    def _handler(_request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return httpx.Response(
                200,
                json=_payload([_entry("llm.structured.temperature", 0.77, type_="float")]),
            )
        raise httpx.ConnectError("flap")

    transport = httpx.MockTransport(_handler)
    async with await _build_client(transport) as client:
        config = ExtractorConfig(client=client, ttl_seconds=0.0)
        first = await config.get("llm.structured.temperature", 0.0)
        with caplog.at_level(logging.WARNING, logger="extractor.config_loader"):
            second = await config.get("llm.structured.temperature", 0.0)
    assert first == 0.77
    # Cache stays populated — the second call serves the old value, not
    # the caller-supplied default.
    assert second == 0.77


async def test_concurrent_get_does_not_thunder_herd() -> None:
    """N concurrent ``.get`` calls on an empty cache cause ONE fetch."""
    call_count = {"n": 0}

    async def _slow_handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        # yield inside the lock window so competing tasks pile up
        await asyncio.sleep(0.05)
        return httpx.Response(
            200,
            json=_payload([_entry("llm.structured.temperature", 0.33, type_="float")]),
        )

    transport = httpx.MockTransport(_slow_handler)
    async with await _build_client(transport) as client:
        config = ExtractorConfig(client=client, ttl_seconds=60.0)
        results = await asyncio.gather(
            *[config.get("llm.structured.temperature", 0.0) for _ in range(8)]
        )
    assert results == [0.33] * 8
    assert call_count["n"] == 1


async def test_returns_default_on_malformed_payload(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A 200 with non-conforming JSON is treated like a fetch failure."""
    response = httpx.Response(200, text="not json at all")
    transport = _make_transport([response])
    async with await _build_client(transport) as client:
        config = ExtractorConfig(client=client, ttl_seconds=60.0)
        with caplog.at_level(logging.WARNING, logger="extractor.config_loader"):
            value = await config.get("llm.structured.temperature", 1.23)
    assert value == 1.23


async def test_wrong_type_returns_default() -> None:
    """When the API returns a value of the wrong type, default wins.

    ``config.get("k", 42)`` where the API has ``"k" -> "hello"`` must
    surface ``42`` — the caller's default fixes the type.
    """
    response = httpx.Response(
        200, json=_payload([_entry("some.int", "not_an_int", type_="string")])
    )
    transport = _make_transport([response])
    async with await _build_client(transport) as client:
        config = ExtractorConfig(client=client, ttl_seconds=60.0)
        value = await config.get("some.int", 42)
    assert value == 42


async def test_string_list_roundtrips() -> None:
    """A ``string_list`` entry must be returned as a Python list[str]."""
    response = httpx.Response(
        200,
        json=_payload(
            [_entry("pipeline.shortener_hosts", ["bit.ly", "t.co"], type_="string_list")]
        ),
    )
    transport = _make_transport([response])
    async with await _build_client(transport) as client:
        config = ExtractorConfig(client=client, ttl_seconds=60.0)
        value = await config.get("pipeline.shortener_hosts", ["default.example"])
    assert value == ["bit.ly", "t.co"]


async def test_get_does_not_raise_on_5xx() -> None:
    """5xx → WARN log + default."""
    response = httpx.Response(503, text="Service Unavailable")
    transport = _make_transport([response])
    async with await _build_client(transport) as client:
        config = ExtractorConfig(client=client, ttl_seconds=60.0)
        value = await config.get("llm.structured.temperature", 0.111)
    assert value == 0.111


async def test_version_is_recorded_for_snapshot_query() -> None:
    """The loader MUST expose the ``Version`` integer per key so the
    :data:`config_snapshot` rider can record ``prompt_version``."""
    response = httpx.Response(
        200,
        json=_payload([_entry("llm.structured.system_prompt", "hello", type_="string", version=7)]),
    )
    transport = _make_transport([response])
    async with await _build_client(transport) as client:
        config = ExtractorConfig(client=client, ttl_seconds=60.0)
        # Warm the cache.
        await config.get("llm.structured.system_prompt", "default")
        assert config.version_of("llm.structured.system_prompt") == 7
        # Missing keys → ``None``, NOT 0 (distinguish "unknown" from "v0").
        assert config.version_of("does.not.exist") is None
