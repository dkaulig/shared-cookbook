# P2-3 — Photo Extraction (paper / screenshots / handwriting)

**Slice:** P2-3
**Status:** planned
**Date:** 2026-04-18
**Depends on:** P2-0 (scaffold) + P2-1 (LLM provider).
**Parent plan:** `docs/plans/2026-04-18-phase-2-architecture.md`.

## Why

User's wife has a paper recipe collection. Vision-LLMs can read handwriting + old recipe cards, convert into structured JSON. Same Review flow as URL extraction — single code path downstream, different extraction frontend.

## Scope

### 1. Endpoint

`POST /extract/photos`

Request:
```json
{
  "photo_urls": ["https://…/signed-1", "https://…/signed-2"],
  "hint": { "group_id": "...", "user_id": "..." }
}
```

- `photo_urls` is ordered — defines reading sequence for multi-page recipes.
- URLs are signed URLs from SeaweedFS (already-uploaded photos via `.NET` proxy).
- 1..10 photos.

Response matches P2-2's shape — `{ recipe: {...}, confidence: {...} }`. Extra field on ingredients/steps: `confidence: "handwritten_uncertain"` when the Vision-LLM flagged ambiguous handwriting.

### 2. Pipeline

File: `apps/python-extractor/src/extractor/pipeline/photo.py`

```python
async def extract_from_photos(
    photo_urls: Sequence[str], provider: LLMProvider
) -> ExtractionResult:
    ...
```

1. **Input validation**: 1..10 URLs. Reject more.
2. **Vision-LLM call**: `provider.vision_extract(system_prompt, images=[...], instruction=build_photo_instruction(len(photo_urls)), json_schema=RECIPE_SCHEMA_WITH_HANDWRITING_CONFIDENCE)`.
3. **Post-process**: same as P2-2 (clamp servings, dedupe tags, ensure position index on steps).

### 3. Prompt

File: `apps/python-extractor/src/extractor/prompts/photo_recipe.py`

```python
SYSTEM_PROMPT_DE = """Du bist Rezept-Digitalisierer. Transkribiere die
gezeigten Fotos zu einem strukturierten Rezept. Erkenne deutsche
Handschrift. Behalte alte Maßeinheiten ("Tasse", "Prise", "Schuss")
bei. Markiere unsichere Stellen mit confidence="handwritten_uncertain".
Setze ursprüngliche Rezept-Überschriften als title. Ignoriere Notizen
am Rand, die offensichtlich nicht zum Rezept gehören (z.B. "für Oma
umsetzen", Datum)."""
```

`build_photo_instruction(n)` adds: "Du siehst **{n}** Fotos, geordnet als zusammenhängendes Dokument. Seite 1 zuerst, Seite {n} zuletzt."

### 4. Tests

Always-on (mocked `LLMProvider`):
- Happy path: 1 photo → structured recipe. `mock.vision_extract` returns canned JSON.
- Multi-page: 3 photos → same recipe, position values preserved.
- Confidence flag: LLM returns ingredient with `confidence="handwritten_uncertain"` → preserved in response.
- Old units kept: LLM returns `unit="Tasse"` → preserved (no conversion).
- Empty photos array → 400.
- 11 photos → 400 "maximal 10 Fotos".

Skipped-by-default:
- `test_vision_live.py` — real Azure Vision call with a committed `.jpg` fixture. Gated behind `AZURE_OPENAI_INTEGRATION=1`.

### 5. No new heavyweight deps

Nothing to add — P2-1's `LLMProvider.vision_extract` is already the transport. No image manipulation, no OCR library. Vision-LLM does it all.

## Non-goals

- No OCR fallback (Tesseract etc.) — Vision-LLM is enough.
- No image orientation correction (Vision-LLM handles).
- No blur detection / quality warning pre-call — Vision-LLM's confidence signal is the only quality-gate in v1.
- No PDF ingest (user uploads pages as images; a future slice can render PDF → images server-side).

## Acceptance criteria

- `pytest` green, all new tests.
- `ruff` / `mypy --strict` clean.
- Image size unchanged (no new deps).
- Web (548) / .NET (474) / shared (32) stay green.

## Anti-shortcut reminders

- TDD all logic.
- Prompt library is just static strings — don't let it accumulate business logic.
- Multi-page position index must be deterministic (1..N in input order), even if the Vision-LLM's position field arrives differently. Override post-response.
- Don't auto-convert old units. User decides at review time.

## Dispatch notes

**Impl agent:**
- Read P2-1 provider interface first.
- Work order: input validation + test → prompt + test → pipeline (mocked provider) → error paths.
- Commit per step.
- Same gates as P2-1 / P2-2.

**Reviewer:**
- Confirm no OCR deps added.
- Confirm multi-page position is deterministic.
- Confirm confidence flag path.
