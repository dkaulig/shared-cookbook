"""COVER-0 bug fix — persistent frame store for the candidate pipeline.

ffmpeg-extracted video frames used to be emitted as ``file://``
URIs inside the pipeline's ``TemporaryDirectory``. The .NET
:class:`CandidateAttacher` can't fetch ``file://`` URLs (its HTTP
client + SSRF allowlist are built for network transports only), and
the temporary directory was auto-deleted as soon as the extraction
returned — leaving the frames unfetchable from the other side of the
.NET ↔ Python bridge.

This module re-roots the frame output on a stable per-extraction UUID
directory under a configurable base path (default
``/var/extractor/frames``). A companion FastAPI route
(``GET /extractor/frames/{dir_id}/{filename}`` — see
:mod:`extractor.main`) serves those frames over HTTP so the .NET side
can fetch them the same way it fetches CDN URLs.

Lifecycle:
- :meth:`FrameStore.allocate` mints a fresh UUID directory per
  extraction invocation. The directory persists until swept.
- :meth:`FrameStore.resolve` validates an externally-supplied
  ``dir_id`` + ``filename`` and returns a filesystem path pointing at
  the frame, or ``None`` if anything looks off (non-UUID shape, wrong
  filename pattern, file missing, traversal attempt).
- :meth:`FrameStore.sweep` drops directories older than a
  caller-supplied TTL (wall-clock mtime). Invoked lazily at the start
  of each new allocation so no background task is required.

Security posture:
- ``dir_id`` is accepted only if it matches the UUID regex at
  :data:`_UUID_PATTERN`. No dots, slashes, or path components make it
  through.
- ``filename`` must match ``<digits>.jpg`` (:data:`_FRAME_FILENAME_RE`).
  Every other shape returns ``None`` before touching the filesystem.
- After building the candidate path we still run a resolved-path
  containment check via :meth:`Path.relative_to` — defence in depth
  against subtle regex escapes (e.g. platform-specific path
  separators).
- The endpoint is scoped to the docker-internal network by design
  (python-extractor is not routed via Caddy — see ``infra/Caddyfile``).
  No auth header is enforced on the fetch path.
"""

from __future__ import annotations

import logging
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Final

logger = logging.getLogger("extractor.frames")

# UUID v4 shape the resolver accepts. Lower- or upper-case hex is fine;
# the regex rejects anything with a slash, dot, or extra character so
# ``..`` or ``/etc/passwd`` never make it through.
_UUID_PATTERN: Final[str] = (
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_UUID_RE: Final[re.Pattern[str]] = re.compile(_UUID_PATTERN)

# Frame filename pattern — ``<digits>.jpg`` only. The ffmpeg extractor
# emits at most 4 frames (indexed 0..3), but any non-negative integer
# passes so tests can exercise larger sets.
_FRAME_FILENAME_RE: Final[re.Pattern[str]] = re.compile(r"^\d+\.jpg$")


class FrameStore:
    """Owner of the ``/var/extractor/frames`` directory hierarchy.

    Parameters
    ----------
    root:
        Base directory that contains one UUID-named subdir per
        extraction. Created on first ``allocate`` if missing.
    url_base:
        Optional HTTP URL prefix for the candidate-thumbnails.
        ``allocate`` surfaces the computed ``<url_base>/<dir_id>``
        alongside the on-disk path so the pipeline doesn't have to
        concat the pieces itself. ``None`` in tests that don't care
        about URL construction.
    """

    __slots__ = ("_root", "_url_base")

    def __init__(self, *, root: Path, url_base: str | None = None) -> None:
        self._root = root
        self._url_base = url_base.rstrip("/") if url_base else None

    @property
    def root(self) -> Path:
        """Return the store's base directory."""
        return self._root

    def allocate(self) -> tuple[str, Path]:
        """Mint a fresh UUID-keyed directory under the store root.

        Returns ``(dir_id, dir_path)``. The directory exists on return.
        Callers own the directory's contents for the remainder of the
        extraction; the sweep pass reclaims it later.
        """
        self._root.mkdir(parents=True, exist_ok=True)
        dir_id = str(uuid.uuid4())
        dir_path = self._root / dir_id
        dir_path.mkdir(parents=True, exist_ok=False)
        return dir_id, dir_path

    def url_for(self, dir_id: str) -> str:
        """Return the HTTP URL prefix for ``dir_id`` or raise if
        ``url_base`` wasn't configured."""
        if self._url_base is None:
            raise RuntimeError("FrameStore.url_for called without a configured url_base.")
        return f"{self._url_base}/{dir_id}"

    def resolve(self, dir_id: str, filename: str) -> Path | None:
        """Return the on-disk path for ``dir_id/filename`` or ``None``.

        Returns ``None`` on any validation miss:
        - ``dir_id`` fails the UUID regex.
        - ``filename`` fails the ``<digits>.jpg`` regex.
        - The resolved path does not live inside :attr:`root`.
        - The target file does not exist.
        """
        if not _UUID_RE.match(dir_id):
            return None
        if not _FRAME_FILENAME_RE.match(filename):
            return None
        candidate = self._root / dir_id / filename
        # Defence-in-depth: even with a regex-clean input, confirm the
        # resolved path is contained within the store root before
        # touching the filesystem. ``strict=False`` so we don't resolve
        # symlinks inside the store — they shouldn't exist but we want
        # to avoid a symlink escape regardless.
        try:
            resolved = candidate.resolve(strict=False)
            root_resolved = self._root.resolve(strict=False)
            resolved.relative_to(root_resolved)
        except (ValueError, OSError):
            return None
        if not resolved.is_file():
            return None
        return resolved

    def sweep(self, *, max_age_seconds: float) -> None:
        """Delete every UUID subdir whose mtime is older than the TTL.

        Best-effort: errors on individual dirs log a warning and the
        sweep continues. Missing root is a no-op.
        """
        if not self._root.exists():
            return
        cutoff = time.time() - max_age_seconds
        try:
            entries = list(self._root.iterdir())
        except OSError as exc:
            logger.warning("frames_sweep_iter_failed err=%s", type(exc).__name__)
            return
        for entry in entries:
            if not entry.is_dir():
                continue
            # Only sweep UUID-named entries; foreign files / dirs
            # shouldn't live here but we refuse to act on them.
            if not _UUID_RE.match(entry.name):
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if mtime > cutoff:
                continue
            try:
                shutil.rmtree(entry)
            except OSError as exc:
                logger.warning(
                    "frames_sweep_rmtree_failed dir=%s err=%s",
                    entry.name,
                    type(exc).__name__,
                )


__all__ = ["FrameStore"]
