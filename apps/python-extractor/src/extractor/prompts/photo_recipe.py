"""Prompt + schema for Vision-LLM photo → structured recipe extraction (P2-3).

Three public items, intentionally parallel to
:mod:`extractor.prompts.recipe_extraction`:

- :data:`PHOTO_RECIPE_SCHEMA` — the URL-path :data:`RECIPE_SCHEMA` with
  ``"handwritten_uncertain"`` added to the ingredient + step confidence
  enums. Old German units (``Tasse``, ``Prise``, ``Schuss``) stay free-
  form on ``unit`` — no conversion at the schema level, that's a review-
  UI decision.
- :data:`SYSTEM_PROMPT_DE` — digitiser role, German handwriting hint,
  old-unit preservation, margin-note filter.
- :func:`build_photo_instruction` — per-request instruction that tells
  the LLM how many photos it's seeing and in what order. Keeps the
  system prompt stable (so it caches well on Azure) while the per-call
  count slots into the user message.

Why a separate module: the URL and photo pipelines share the same
:class:`ExtractionResult` shape downstream, but the Vision-LLM needs
slightly different framing + one extra confidence literal. Copying the
base ``RECIPE_SCHEMA`` into a mutable dict here means we can extend the
two confidence enums without cross-contaminating the URL path — that's
tested explicitly in ``test_photo_prompts``.
"""

from __future__ import annotations

import copy
from typing import Any, Final

from extractor.prompts.recipe_extraction import RECIPE_SCHEMA

# ─────────────────────────────────────────────────────────────────────
# JSON Schema — extends RECIPE_SCHEMA with "handwritten_uncertain"
# ─────────────────────────────────────────────────────────────────────


def _build_photo_recipe_schema() -> dict[str, Any]:
    """Produce a deep-copied schema with the photo-specific confidences.

    The base schema lives in :data:`RECIPE_SCHEMA`; we deep-copy so
    mutating the nested ``confidence.enum`` arrays doesn't leak into
    the URL-path schema. The test
    ``test_photo_recipe_schema_does_not_mutate_base_recipe_schema``
    pins that invariant.
    """
    schema = copy.deepcopy(RECIPE_SCHEMA)

    ingredients_items = schema["properties"]["ingredients"]["items"]
    ingredient_confidence = ingredients_items["properties"]["confidence"]
    ingredient_confidence["enum"] = [
        *ingredient_confidence["enum"],
        "handwritten_uncertain",
    ]

    steps_items = schema["properties"]["steps"]["items"]
    step_confidence = steps_items["properties"]["confidence"]
    step_confidence["enum"] = [
        *step_confidence["enum"],
        "handwritten_uncertain",
    ]

    return schema


PHOTO_RECIPE_SCHEMA: Final[dict[str, Any]] = _build_photo_recipe_schema()

# ─────────────────────────────────────────────────────────────────────
# System prompt
# ─────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT_DE: Final[str] = (
    "Du bist Rezept-Digitalisierer. Transkribiere die gezeigten Fotos zu "
    "einem strukturierten Rezept. Erkenne deutsche Handschrift. Behalte "
    'alte Maßeinheiten ("Tasse", "Prise", "Schuss", "Messerspitze") '
    "unverändert bei — rechne nicht in Gramm oder Milliliter um. "
    "Markiere einzelne Zutaten oder Schritte, bei denen du dir "
    "unsicher bist (schwer lesbare Handschrift, Flecken, Abkürzungen), "
    'mit confidence="handwritten_uncertain". Setze ursprüngliche '
    "Rezept-Überschriften als title. Ignoriere Notizen am Rand, die "
    'offensichtlich nicht zum Rezept gehören (z.B. "für Oma umsetzen", '
    "Datumsangaben, Haushaltslisten). Antworte ausschließlich im "
    "geforderten JSON-Schema; erfinde keine Zutaten oder Mengen. Wenn "
    "eine Information fehlt, setze das entsprechende Feld auf null. "
    "Für Zutaten ohne erkennbare Menge setze `quantity` auf null und "
    '`confidence` auf "missing". Tags sind kurze Kleinbuchstaben-'
    'Stichwörter (z.B. "kuchen", "backen", "sonntag"). '
    "Das Feld `description` ist AUSSCHLIESSLICH eine knappe 1-2-Satz-"
    'Zusammenfassung des Gerichts (z.B. "Klassischer Rührteig mit '
    'Äpfeln"). Wiederhole dort NIEMALS Schritte, Zutaten, Mengenangaben '
    "oder Zubereitungsanweisungen. Wenn keine sinnvolle Zusammenfassung "
    "ableitbar ist, setze `description` auf null. "
    'Wenn du eine Zahl mit Einheit hörst oder liest ("200 g", "500 ml", '
    '"3 EL"), gehört sie IMMER in `quantity` + `unit` EINER Zutat-Zeile. '
    "Niemals in `description`, `note` oder andere Felder. Bei Unsicherheit "
    'setze `confidence="uncertain"` UND ordne die Menge trotzdem zu einer '
    'Zutat zu. NIEMALS Portionszahl ("2 Personen") als Zutatenmenge '
    "interpretieren — das gehört in `servings`. "
    "Alle Mengenangaben MÜSSEN metrisch und auf Deutsch sein. Erlaubte "
    "Einheiten: g, kg, ml, l, EL, TL, Stück, Prise, Bund, Tasse, Becher, "
    "Scheibe, Zehe. Rechne imperial-Einheiten aktiv um: "
    "1 oz = 28 g, 1 lb = 454 g; "
    "1 cup = 240 ml, 1 tbsp = 15 ml, 1 tsp = 5 ml, 1 fl oz = 30 ml; "
    "1 clove = 1 Zehe, 1 stick (Butter) = 113 g; "
    "1 pinch = 1 Prise, 1 slice = 1 Scheibe, 1 bunch = 1 Bund, "
    "1 piece = 1 Stück. "
    'Gib ausschließlich die umgerechnete Einheit zurück — niemals "oz", '
    '"cup", "tbsp" etc. im Output. '
    "Schätze pro Portion die Nährwerte (kcal, protein_g, carbs_g, "
    "fat_g) als ganze Zahlen und gib sie im Feld `nutrition_estimate` "
    "zurück. Die Werte beziehen sich auf EINE Portion. Wenn du Mengen "
    "auf dem Foto nicht einschätzen kannst, setze `nutrition_estimate` "
    "auf null — erfinde keine Zahlen."
)

# ─────────────────────────────────────────────────────────────────────
# Per-request instruction builder
# ─────────────────────────────────────────────────────────────────────


def build_photo_instruction(n: int) -> str:
    """Return the per-call instruction text for ``n`` ordered photos.

    The Vision-LLM receives this as the ``instruction`` argument
    (:meth:`LLMProvider.vision_extract`) alongside the photo URL
    sequence. Naming the count + the reading direction keeps the LLM
    from treating each image as an independent recipe when a single
    recipe happens to span two cookbook pages.

    Parameters
    ----------
    n
        Number of photos the caller is sending. Must be ≥ 1 — the
        pipeline layer enforces the 1..10 cap, but we still defend
        here because a bug upstream could produce ``"0 Fotos"`` which
        reads nonsensically to the LLM.
    """
    if n < 1:
        raise ValueError(f"build_photo_instruction: n must be >= 1, got {n}")
    return (
        f"Du siehst {n} Fotos, geordnet als zusammenhängendes Dokument. "
        f"Seite 1 zuerst, Seite {n} zuletzt. Extrahiere ein einzelnes "
        "Rezept aus allen Seiten zusammen und gib das Ergebnis als JSON "
        "zurück, das dem Schema entspricht."
    )


__all__ = [
    "PHOTO_RECIPE_SCHEMA",
    "SYSTEM_PROMPT_DE",
    "build_photo_instruction",
]
