"""Typed runtime configuration loaded from process environment.

Built on ``pydantic-settings`` so:
- env-var parsing + type coercion is handled centrally;
- field docs double as a config-surface reference;
- ``Settings()`` with no args works at module scope (later slices will
  cache a singleton).

Azure OpenAI fields are present now but unused — P2-0 is a scaffold.
They default to empty strings so ``docker compose up`` doesn't fail on
missing envs. Each sub-slice that actually calls Azure OpenAI (P2-1
onward) validates non-empty at its own call site; we deliberately do
NOT enforce non-empty here because many deployments (tests, local
hacking, CI) run without credentials and still need a bootable service.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-driven configuration for the extractor service."""

    service_name: str = "extractor"
    log_level: str = "INFO"

    # Azure OpenAI placeholders — consumed from P2-1 onward.
    azure_openai_endpoint: str = ""
    azure_openai_api_key: str = ""
    azure_openai_api_version: str = "2025-04-01-preview"
    azure_openai_deployment_structuring: str = "gpt-4.1"
    azure_openai_deployment_chat: str = "gpt-5.1-chat"

    # HMAC shared secret for the .NET ↔ Python bridge (P2-6).
    extractor_shared_secret: str = ""

    # CFG-1: base URL of the .NET API's internal extractor-config
    # endpoint. Defaults to the docker-compose service name so the
    # in-cluster happy path needs no env override. Leave blank to
    # disable config-fetching entirely (e.g. in tests or local hacking
    # where the .NET API isn't running) — the loader then falls back to
    # hardcoded defaults on every ``.get`` call.
    extractor_config_api_base: str = "http://api:8080"

    # CFG-1: TTL (seconds) on the extractor-config cache. 60 s is the
    # design-doc default; tune via env without a rebuild when iterating
    # on prompts (shorter TTL → faster feedback loop).
    extractor_config_ttl_seconds: float = 60.0

    # COVER-0 fix: on-disk root for ffmpeg-extracted video frames. The
    # pipeline writes one UUID-keyed subdir per extraction and serves
    # the files via GET /extractor/frames/{dir_id}/{filename} so the
    # .NET CandidateAttacher can fetch them like a regular CDN URL. The
    # default lives outside the app's working dir because Docker mounts
    # a tmpfs there (see docker-compose.yml) — bounded size protects
    # against a runaway extraction filling the disk.
    extractor_frames_dir: str = "/var/extractor/frames"

    # COVER-0 fix: URL prefix the candidate_thumbnails emit for
    # ffmpeg-extracted frames. Points at this same service's own
    # ``/extractor/frames`` route, using the docker-compose hostname so
    # the .NET CandidateAttacher can reach it over the internal
    # network. No trailing slash — the extractor appends
    # ``/<dir_id>/<idx>.jpg`` itself.
    extractor_frames_url_base: str = "http://python-extractor:8000/extractor/frames"

    # COVER-0 fix: TTL after which the sweep pass reclaims a frame
    # directory. 1 hour comfortably covers the window between "Python
    # returns candidate_thumbnails" and ".NET CandidateAttacher has
    # downloaded and staged them"; anything still referenced past that
    # boundary is either a stuck import or a bug, and losing the frames
    # is the right failure mode (the import itself remains usable).
    extractor_frames_ttl_seconds: float = 3600.0

    # `env_file=None`: we rely on docker-compose + the VPS .env handling
    # for real runs, not a per-service .env file. Tests override via
    # monkeypatch on os.environ.
    # `extra="ignore"`: the process environment is noisy (PATH, HOME, …);
    # don't crash on unrelated vars.
    # `case_sensitive=False`: docker-compose emits UPPERCASE, code uses
    # snake_case — pydantic-settings matches them by lowering both sides.
    model_config = SettingsConfigDict(
        env_file=None,
        extra="ignore",
        case_sensitive=False,
    )
