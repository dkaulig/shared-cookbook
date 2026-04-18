"""Prompt library + JSON schemas for LLM-driven extraction.

Each module here contains exactly one task's worth of prompts + schema:

- :mod:`extractor.prompts.recipe_extraction` — URL + blog → recipe JSON.

Prompt engineering lives in its own files (not interleaved with the
pipeline glue) so the strings are easy to review side-by-side with the
LLM schema, and so tests can lock them in without pulling in FastAPI /
httpx.
"""

from __future__ import annotations
