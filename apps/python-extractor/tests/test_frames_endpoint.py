"""COVER-0 bug fix — tests for the ``/extractor/frames/{dir_id}/{filename}``
HTTP route.

The endpoint serves ffmpeg-extracted frames by UUID + filename so the
.NET :class:`CandidateAttacher` can fetch them over HTTP instead of
trying to follow the ``file://`` URIs the pipeline used to emit.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from extractor.frames import FrameStore
from extractor.main import create_app, get_frame_store


@pytest.fixture()
def frame_store_root(tmp_path: Path) -> Path:
    """Fresh per-test frame-store root."""
    root = tmp_path / "frames"
    root.mkdir()
    return root


@pytest.fixture()
def frame_store(frame_store_root: Path) -> FrameStore:
    return FrameStore(root=frame_store_root)


@pytest.fixture()
def frame_client(frame_store: FrameStore) -> TestClient:
    """App with an overridden FrameStore so tests stage files directly.

    NOT wrapped in ``with TestClient(...)`` on purpose — the app's
    lifespan kicks off a Whisper model prefetch, which in CI has no
    model cache to reuse and blocks each test ~30 s. Skipping the
    lifespan is safe here because the frames endpoint only depends on
    the dependency-overridden FrameStore, nothing that startup wires up.
    """
    app = create_app()
    app.dependency_overrides[get_frame_store] = lambda: frame_store
    return TestClient(app)


def test_serves_existing_frame_as_jpeg(frame_client: TestClient, frame_store: FrameStore) -> None:
    """Happy path: UUID + ``<digits>.jpg`` that exists on disk → 200 + bytes."""
    dir_id, dir_path = frame_store.allocate()
    body = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00stub"
    (dir_path / "0.jpg").write_bytes(body)

    response = frame_client.get(f"/extractor/frames/{dir_id}/0.jpg")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/jpeg")
    assert response.content == body


def test_returns_404_for_missing_file(frame_client: TestClient, frame_store: FrameStore) -> None:
    dir_id, _ = frame_store.allocate()
    response = frame_client.get(f"/extractor/frames/{dir_id}/7.jpg")
    assert response.status_code == 404


def test_returns_404_for_missing_dir(frame_client: TestClient) -> None:
    response = frame_client.get(f"/extractor/frames/{uuid.uuid4()}/0.jpg")
    assert response.status_code == 404


def test_rejects_non_uuid_dir_id(frame_client: TestClient) -> None:
    response = frame_client.get("/extractor/frames/not-a-uuid/0.jpg")
    # Pydantic path validation fires on a non-UUID regex match — returns
    # 422 before the handler sees it.
    assert response.status_code in (404, 422)


def test_rejects_traversal_attempt(frame_client: TestClient) -> None:
    # The URL router resolves .. before our handler, but starlette's
    # default behaviour returns 404. Either way: no file served.
    response = frame_client.get("/extractor/frames/..%2F..%2Fetc/0.jpg")
    assert response.status_code in (404, 422)


def test_rejects_non_jpg_filename(frame_client: TestClient, frame_store: FrameStore) -> None:
    dir_id, dir_path = frame_store.allocate()
    # Plant a file with a different extension; endpoint refuses it.
    (dir_path / "malicious.sh").write_bytes(b"#!/bin/sh\nrm -rf /")
    response = frame_client.get(f"/extractor/frames/{dir_id}/malicious.sh")
    assert response.status_code in (404, 422)


def test_rejects_name_with_dot_dot(frame_client: TestClient, frame_store: FrameStore) -> None:
    dir_id, _ = frame_store.allocate()
    response = frame_client.get(f"/extractor/frames/{dir_id}/..%2F..%2F0.jpg")
    assert response.status_code in (404, 422)


def test_frames_endpoint_bypasses_hmac(tmp_path: Path) -> None:
    """The frames route does not require the .NET HMAC headers — the
    .NET CandidateAttacher's HttpClient is unsigned. Build an app with
    a non-empty shared secret + confirm the frames route still serves
    successfully while other routes would 401."""
    import os

    prev_secret = os.environ.get("EXTRACTOR_SHARED_SECRET")
    os.environ["EXTRACTOR_SHARED_SECRET"] = "test-secret"  # noqa: S105 — fake secret for this test
    try:
        # Invalidate the Settings cache so the new env var is picked up.
        from extractor import main as main_module

        main_module._get_settings.cache_clear()
        app = create_app()
        root = tmp_path / "frames"
        store = FrameStore(root=root)
        dir_id, dir_path = store.allocate()
        (dir_path / "0.jpg").write_bytes(b"jpg-bytes")
        app.dependency_overrides[get_frame_store] = lambda: store

        with TestClient(app) as client:
            # Frames route succeeds without any signing headers.
            resp = client.get(f"/extractor/frames/{dir_id}/0.jpg")
            assert resp.status_code == 200
            # Meanwhile the /extract/url path fails HMAC without the
            # signing headers — proves the middleware is active.
            other = client.post(
                "/extract/url",
                json={
                    "url": "https://example.com",
                    "hint": {"group_id": "g", "user_id": "u"},
                },
            )
            assert other.status_code == 401
    finally:
        if prev_secret is None:
            os.environ.pop("EXTRACTOR_SHARED_SECRET", None)
        else:
            os.environ["EXTRACTOR_SHARED_SECRET"] = prev_secret
        from extractor import main as main_module

        main_module._get_settings.cache_clear()
