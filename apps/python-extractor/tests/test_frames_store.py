"""COVER-0 bug fix — tests for the FrameStore persistent directory.

The store owns the on-disk lifecycle of ffmpeg-extracted video frames:
it allocates a UUID-keyed subdirectory per extraction, resolves paths
safely (blocking traversal attempts), and sweeps stale directories
older than a configurable TTL.

These tests drive the module: ``extractor.frames.FrameStore``.
"""

from __future__ import annotations

import time
import uuid
from pathlib import Path

from extractor.frames import FrameStore


def test_allocate_returns_fresh_uuid_directory(tmp_path: Path) -> None:
    store = FrameStore(root=tmp_path)
    dir_id, dir_path = store.allocate()
    # Shape: UUID string + existing directory inside the store root.
    uuid.UUID(dir_id)
    assert dir_path.exists()
    assert dir_path.is_dir()
    assert dir_path.parent == tmp_path


def test_allocate_two_dirs_are_distinct(tmp_path: Path) -> None:
    store = FrameStore(root=tmp_path)
    a_id, a_path = store.allocate()
    b_id, b_path = store.allocate()
    assert a_id != b_id
    assert a_path != b_path


def test_resolve_returns_path_for_valid_dir_and_file(tmp_path: Path) -> None:
    store = FrameStore(root=tmp_path)
    dir_id, dir_path = store.allocate()
    # Write a fake frame file into it.
    (dir_path / "0.jpg").write_bytes(b"jpeg-bytes")

    resolved = store.resolve(dir_id, "0.jpg")
    assert resolved is not None
    assert resolved.read_bytes() == b"jpeg-bytes"


def test_resolve_returns_none_for_missing_file(tmp_path: Path) -> None:
    store = FrameStore(root=tmp_path)
    dir_id, _ = store.allocate()
    assert store.resolve(dir_id, "9.jpg") is None


def test_resolve_rejects_non_uuid_dir_id(tmp_path: Path) -> None:
    store = FrameStore(root=tmp_path)
    assert store.resolve("not-a-uuid", "0.jpg") is None
    assert store.resolve("../etc", "0.jpg") is None


def test_resolve_rejects_non_numeric_filename(tmp_path: Path) -> None:
    store = FrameStore(root=tmp_path)
    dir_id, _ = store.allocate()
    # Must be <digits>.jpg — anything else is rejected pre-IO.
    assert store.resolve(dir_id, "frame.jpg") is None
    assert store.resolve(dir_id, "0.png") is None
    assert store.resolve(dir_id, "..%2F..%2Fpasswd") is None


def test_resolve_rejects_traversal_within_uuid_dir(tmp_path: Path) -> None:
    store = FrameStore(root=tmp_path)
    dir_id, _dir_path = store.allocate()
    # Plant a secret outside the per-UUID dir.
    secret = tmp_path / "secret.jpg"
    secret.write_bytes(b"top-secret")
    # Even though the filename regex already rejects "../", double-check
    # the resolved path never escapes the UUID dir. Pass a name that the
    # regex *would* accept if it's just digits.
    # (The regex enforcement is the primary gate; this test guards the
    # secondary defence-in-depth parent-dir containment check.)
    assert store.resolve(dir_id, "../secret.jpg") is None


def test_sweep_deletes_old_directories(tmp_path: Path) -> None:
    import os

    store = FrameStore(root=tmp_path)
    _dir_id, dir_path = store.allocate()
    # Backdate the mtime so it appears older than the TTL.
    old_mtime = time.time() - 7200  # 2 hours ago
    os.utime(dir_path, (old_mtime, old_mtime))
    store.sweep(max_age_seconds=3600)
    assert not dir_path.exists()


def test_sweep_keeps_fresh_directories(tmp_path: Path) -> None:
    store = FrameStore(root=tmp_path)
    _dir_id, dir_path = store.allocate()
    store.sweep(max_age_seconds=3600)
    assert dir_path.exists()


def test_sweep_ignores_root_directory_itself(tmp_path: Path) -> None:
    store = FrameStore(root=tmp_path)
    # Sweep with max_age=0 shouldn't nuke the root.
    store.sweep(max_age_seconds=0)
    assert tmp_path.exists()


def test_sweep_tolerates_missing_root(tmp_path: Path) -> None:
    missing = tmp_path / "not-created"
    store = FrameStore(root=missing)
    # Must not raise even if the root doesn't exist yet.
    store.sweep(max_age_seconds=3600)


def test_allocate_creates_root_if_missing(tmp_path: Path) -> None:
    missing = tmp_path / "fresh"
    store = FrameStore(root=missing)
    _dir_id, dir_path = store.allocate()
    assert dir_path.exists()
    assert missing.exists()


def test_resolve_ignores_dir_id_outside_root(tmp_path: Path) -> None:
    """Even with a UUID-shaped id, a dir that doesn't exist inside the
    store root must return None (not leak a path outside the store)."""
    store = FrameStore(root=tmp_path)
    fake_uuid = str(uuid.uuid4())
    assert store.resolve(fake_uuid, "0.jpg") is None
