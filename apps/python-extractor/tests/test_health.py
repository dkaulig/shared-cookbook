"""Smoke tests for the GET /health endpoint.

Keep these asserting on the documented contract — the .NET side + the
Docker HEALTHCHECK both depend on the exact shape.
"""

from __future__ import annotations

from importlib.metadata import version as pkg_version

from fastapi.testclient import TestClient


def test_health_returns_200(client: TestClient) -> None:
    """GET /health returns HTTP 200."""
    response = client.get("/health")
    assert response.status_code == 200


def test_health_returns_json_content_type(client: TestClient) -> None:
    """Response is JSON, not HTML or plain text."""
    response = client.get("/health")
    assert response.headers["content-type"].startswith("application/json")


def test_health_payload_has_status_ok(client: TestClient) -> None:
    """`status` must be exactly the literal string 'ok'."""
    payload = client.get("/health").json()
    assert payload["status"] == "ok"


def test_health_payload_identifies_service(client: TestClient) -> None:
    """`service` pins the service identity so ops/monitoring can distinguish
    this container from api/web in a shared log stream."""
    payload = client.get("/health").json()
    assert payload["service"] == "shared-cookbook-extractor"


def test_health_payload_exposes_package_version(client: TestClient) -> None:
    """`version` reads from the installed package metadata — not a hardcoded
    constant — so a mismatched deploy can't silently ship the wrong image."""
    payload = client.get("/health").json()
    expected = pkg_version("shared-cookbook-extractor")
    assert payload["version"] == expected
    assert isinstance(payload["version"], str)
    assert len(payload["version"]) > 0


def test_health_payload_has_exactly_three_keys(client: TestClient) -> None:
    """Guard against accidental payload drift — if a future slice adds
    fields here, they need a matching test + a plan-doc update."""
    payload = client.get("/health").json()
    assert set(payload.keys()) == {"status", "service", "version"}
