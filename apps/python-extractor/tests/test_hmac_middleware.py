"""Tests for :mod:`extractor.security.hmac_middleware`.

Builds a dedicated FastAPI app wired with the middleware so we can
exercise the verification logic in isolation from the main app's
routing. The health-check bypass is also tested on the main app.
"""

from __future__ import annotations

import hashlib
import hmac
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from extractor.security.hmac_middleware import (
    HEALTH_BYPASS_PATHS,
    MAX_SKEW_SECONDS,
    HmacVerificationMiddleware,
)

# Header names matching the .NET signer exactly.
_SIG = "X-Extractor-Signature"
_TS = "X-Extractor-Timestamp"
_UID = "X-User-Id"

_SECRET = "dev-only-shared-secret"  # noqa: S105  — test fixture, not a credential
_JSON = {"content-type": "application/json"}


def _build_app(secret: str = _SECRET) -> FastAPI:
    """Tiny FastAPI app that just echoes a 200 from ``POST /ping``.

    The health route is registered so the bypass path has something to
    hit without requiring any downstream plumbing.
    """
    app = FastAPI()
    app.add_middleware(HmacVerificationMiddleware, shared_secret=secret)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/ping")
    async def ping(payload: dict[str, str]) -> dict[str, str]:
        return {"echo": payload.get("x", "")}

    return app


def _sign(
    user_id: str,
    body: bytes,
    *,
    timestamp: int | None = None,
    secret: str = _SECRET,
) -> dict[str, str]:
    ts = str(timestamp if timestamp is not None else int(time.time()))
    body_hash = hashlib.sha256(body).hexdigest()
    payload = f"{user_id}|{ts}|{body_hash}".encode()
    sig = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return {_UID: user_id, _TS: ts, _SIG: sig}


def _post(
    client: TestClient,
    body: bytes,
    headers: dict[str, str],
) -> object:  # pragma: no cover — helper
    return client.post("/ping", content=body, headers={**headers, **_JSON})


def test_valid_signature_passes_through() -> None:
    app = _build_app()
    client = TestClient(app)
    body = b'{"x":"hello"}'
    headers = _sign("11111111-1111-1111-1111-111111111111", body)

    response = _post(client, body, headers)

    assert response.status_code == 200  # type: ignore[attr-defined]
    assert response.json() == {"echo": "hello"}  # type: ignore[attr-defined]


def test_missing_signature_header_returns_401() -> None:
    app = _build_app()
    client = TestClient(app)
    body = b'{"x":"hello"}'
    headers = _sign("u", body)
    headers.pop(_SIG)

    response = _post(client, body, headers)

    assert response.status_code == 401  # type: ignore[attr-defined]
    assert "Fehlende" in response.json()["detail"]  # type: ignore[attr-defined]


def test_missing_timestamp_header_returns_401() -> None:
    app = _build_app()
    client = TestClient(app)
    body = b'{"x":"hello"}'
    headers = _sign("u", body)
    headers.pop(_TS)

    response = _post(client, body, headers)

    assert response.status_code == 401  # type: ignore[attr-defined]


def test_missing_user_id_header_returns_401() -> None:
    app = _build_app()
    client = TestClient(app)
    body = b'{"x":"hello"}'
    headers = _sign("u", body)
    headers.pop(_UID)

    response = _post(client, body, headers)

    assert response.status_code == 401  # type: ignore[attr-defined]


def test_invalid_signature_returns_401() -> None:
    app = _build_app()
    client = TestClient(app)
    body = b'{"x":"hello"}'
    headers = _sign("u", body)
    headers[_SIG] = "0" * 64  # Wrong hex.

    response = _post(client, body, headers)

    assert response.status_code == 401  # type: ignore[attr-defined]
    assert "Ungültige Signatur" in response.json()["detail"]  # type: ignore[attr-defined]


def test_wrong_secret_on_signer_returns_401() -> None:
    # Signed with a different secret — server must reject.
    app = _build_app(secret=_SECRET)
    client = TestClient(app)
    body = b'{"x":"hello"}'
    headers = _sign("u", body, secret="not-the-right-secret")  # noqa: S106  — test fixture

    response = _post(client, body, headers)

    assert response.status_code == 401  # type: ignore[attr-defined]


def test_expired_timestamp_returns_401() -> None:
    app = _build_app()
    client = TestClient(app)
    body = b"{}"
    stale = int(time.time()) - (MAX_SKEW_SECONDS + 60)
    headers = _sign("u", body, timestamp=stale)

    response = _post(client, body, headers)

    assert response.status_code == 401  # type: ignore[attr-defined]
    assert "Zeitstempel" in response.json()["detail"]  # type: ignore[attr-defined]


def test_future_timestamp_beyond_window_returns_401() -> None:
    app = _build_app()
    client = TestClient(app)
    body = b"{}"
    future = int(time.time()) + (MAX_SKEW_SECONDS + 60)
    headers = _sign("u", body, timestamp=future)

    response = _post(client, body, headers)

    assert response.status_code == 401  # type: ignore[attr-defined]


def test_non_numeric_timestamp_returns_401() -> None:
    app = _build_app()
    client = TestClient(app)
    body = b"{}"
    headers = _sign("u", body)
    headers[_TS] = "not-a-number"

    response = _post(client, body, headers)

    assert response.status_code == 401  # type: ignore[attr-defined]


def test_within_skew_window_passes() -> None:
    """Timestamp at the edge of the window (skew - 30s) still passes."""
    app = _build_app()
    client = TestClient(app)
    edge = int(time.time()) - (MAX_SKEW_SECONDS - 30)
    headers = _sign("u", b'{"x":"edge"}', timestamp=edge)

    response = _post(client, b'{"x":"edge"}', headers)

    assert response.status_code == 200  # type: ignore[attr-defined]


def test_health_endpoint_bypasses_verification() -> None:
    app = _build_app()
    client = TestClient(app)

    # No headers at all — /health must still respond 200.
    response = client.get("/health")

    assert response.status_code == 200


def test_bypass_paths_default_is_just_health() -> None:
    # Guard: accidentally expanding the bypass set is a security regression.
    assert frozenset({"/health"}) == HEALTH_BYPASS_PATHS


def test_empty_secret_fails_closed_on_protected_route() -> None:
    """Empty secret + protected route → 500, never silent pass-through."""
    app = FastAPI()
    app.add_middleware(HmacVerificationMiddleware, shared_secret="")

    @app.post("/ping")
    async def ping() -> dict[str, str]:
        return {"ok": "yes"}

    client = TestClient(app)
    response = client.post("/ping")

    assert response.status_code == 500


def test_body_tampering_changes_hash() -> None:
    """Signed for body A, sent with body B → 401."""
    app = _build_app()
    client = TestClient(app)
    headers = _sign("u", b'{"a":1}')

    response = _post(client, b'{"a":2}', headers)

    assert response.status_code == 401  # type: ignore[attr-defined]


def test_shared_secret_never_echoed_in_response() -> None:
    """Response body must never contain the raw secret — caplog guard."""
    app = _build_app()
    client = TestClient(app)

    response = client.post("/ping", content=b"{}", headers=_JSON)

    assert response.status_code == 401
    assert _SECRET not in response.text


def test_secret_never_logged(caplog: pytest.LogCaptureFixture) -> None:
    """Rejection logs MUST NOT contain the raw shared secret."""
    app = _build_app()
    client = TestClient(app)

    with caplog.at_level("INFO", logger="extractor.security.hmac_middleware"):
        client.post("/ping", content=b"{}", headers=_JSON)

    for record in caplog.records:
        assert _SECRET not in record.getMessage()
