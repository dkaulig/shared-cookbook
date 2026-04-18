"""URL + blog extraction pipeline.

Public surface consumed by the FastAPI ``POST /extract/url`` endpoint:

- :mod:`extractor.pipeline.types`  — response-shape TypedDicts.
- :mod:`extractor.pipeline.blog`   — three-layer blog-page extractors.
- :mod:`extractor.pipeline.video`  — ``VideoDownloader`` / ``Transcriber``
  protocols + yt-dlp / faster-whisper implementations + stubs.
- :mod:`extractor.pipeline.url`    — orchestration glue (HEAD classify →
  video or blog path → LLM structuring → post-process).

Each module is deliberately narrow; the glue lives in ``url.py`` only.
"""

from __future__ import annotations
