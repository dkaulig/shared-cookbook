"""REL-8 — tests for the JSON-LD Recipe pre-LLM branch.

The :mod:`extractor.pipeline.jsonld_parser` module scans an HTML string
for ``<script type="application/ld+json">`` blocks, finds a
``schema.org/Recipe`` entity (also inside ``@graph`` arrays), and maps
it to the same ``llm_output`` dict shape that the Azure provider
returns. That shape is then fed through the existing :func:`post_process`
pipeline so the whole defensive clamp / normalisation suite applies for
free.

The tests cover:

- Happy-path end-to-end (German + English fixtures, ``@graph`` variant,
  nested ``HowToSection`` instructions).
- Every field-mapping edge case documented in the design doc:
  ``@type`` shapes, ``recipeInstructions`` variants, ``recipeYield``
  variants, ISO 8601 durations, ``nutrition`` units, ``image`` shapes,
  comma-decimals + fractions in ingredient lines.
- The pre-LLM branch's contract: returns ``None`` on absence, malformed
  JSON, non-Recipe-``@type``, or when the parsed output fails the
  minimum-validity check (no title / ingredients / steps).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from extractor.pipeline.jsonld_parser import (
    extract_recipe_from_html,
    iso_duration_to_minutes,
    parse_ingredient_line,
    parse_servings,
)

_FIXTURE_DIR = Path(__file__).parent / "fixtures" / "jsonld"


def _load(name: str) -> str:
    return (_FIXTURE_DIR / name).read_text(encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────
# End-to-end: fixtures → llm_output-shaped dict
# ─────────────────────────────────────────────────────────────────────


def test_chefkoch_sample_maps_to_llm_output_shape() -> None:
    """German blog with full schema.org/Recipe → llm_output dict."""
    result = extract_recipe_from_html(_load("chefkoch_sample.html"))
    assert result is not None

    assert result["title"] == "Apfelkuchen vom Blech"
    assert result["description"] == "Saftiger Apfelkuchen mit Streuseln für die ganze Familie."
    assert result["servings"] == 12
    assert result["prep_minutes"] == 25
    assert result["cook_minutes"] == 45

    # Single component holds all ingredients + steps (the parser never
    # splits into multiple components — JSON-LD has no component concept).
    assert len(result["components"]) == 1
    component = result["components"][0]
    assert component["label"] is None
    assert component["position"] == 0

    # 8 ingredient lines in the fixture.
    assert len(component["ingredients"]) == 8
    # First line: "500 g Mehl" → quantity="500", unit="g", name="Mehl".
    first = component["ingredients"][0]
    assert first["name"] == "Mehl"
    assert first["quantity"] == "500"
    assert first["unit"] == "g"
    assert first["confidence"] == "high"

    # Comma-decimal line: "0,25 l Milch" → quantity="0,25", unit="l".
    milk = next(i for i in component["ingredients"] if "Milch" in i["name"])
    assert milk["quantity"] == "0,25"
    assert milk["unit"] == "l"

    # 4 instruction steps.
    assert len(component["steps"]) == 4
    assert component["steps"][0]["position"] == 1
    assert "Streuseln" in component["steps"][0]["content"]
    assert component["steps"][0]["confidence"] == "high"

    # Tags come from recipeCategory + keywords (merged, lowercased by
    # post_process later; here raw).
    assert "kuchen" in [t.lower() for t in result["tags"]]

    # Nutrition parsed from string-with-unit to int.
    nutrition = result["nutrition_estimate"]
    assert nutrition is not None
    assert nutrition["kcal"] == 320
    assert nutrition["protein_g"] == 5
    assert nutrition["carbs_g"] == 45
    assert nutrition["fat_g"] == 12


def test_seriouseats_sample_handles_english_imperial_and_array_type() -> None:
    """English blog with ``@type: [Recipe, NewsArticle]`` + imperial units."""
    result = extract_recipe_from_html(_load("seriouseats_sample.html"))
    assert result is not None

    assert result["title"] == "Classic Chocolate Chip Cookies"
    assert result["servings"] == 24  # "24 cookies" — first-int wins
    assert result["prep_minutes"] == 20
    assert result["cook_minutes"] == 12

    component = result["components"][0]
    # Fraction ingredient: "2 1/4 cups all-purpose flour".
    flour = next(i for i in component["ingredients"] if "flour" in i["name"].lower())
    assert flour["quantity"] == "2 1/4"
    assert flour["unit"] == "cups"

    # Prose-string recipeInstructions → single step (the parser keeps it
    # intact; the LLM-style post_process renumbers to position=1).
    assert len(component["steps"]) >= 1
    assert component["steps"][0]["position"] == 1


def test_graph_sample_finds_recipe_inside_graph_array() -> None:
    """A @graph array with mixed entities finds the Recipe."""
    result = extract_recipe_from_html(_load("graph_sample.html"))
    assert result is not None

    assert result["title"] == "Simple White Bread"
    # recipeYield as a raw int → parsed through _int.
    assert result["servings"] == 1
    # image is an ImageObject dict — parser accepts the {url: …} shape.
    # (we don't test the URL directly — the parser only uses image for
    # candidate_thumbnails which the pipeline wires separately)

    component = result["components"][0]
    assert len(component["ingredients"]) == 4
    # Instructions as array of plain strings.
    assert len(component["steps"]) == 3
    assert component["steps"][0]["position"] == 1
    assert component["steps"][0]["content"] == "Mix dry ingredients."


def test_howto_section_flattens_nested_steps() -> None:
    """HowToSection with itemListElement → flat steps."""
    result = extract_recipe_from_html(_load("howto_section_sample.html"))
    assert result is not None
    assert result["servings"] == 6  # "6-8 servings" — first int wins

    component = result["components"][0]
    # 2 HowToSections (2+2 steps) + 1 bare HowToStep = 5 total.
    assert len(component["steps"]) == 5
    positions = [s["position"] for s in component["steps"]]
    assert positions == [1, 2, 3, 4, 5]
    # Section 1 step 2 is "Add passata…" — section.name is NOT flattened
    # into step text, only itemListElement children are.
    assert "passata" in component["steps"][1]["content"].lower()
    # Final entry is the bare HowToStep at the end of the list.
    assert component["steps"][4]["content"].lower().startswith("bake")


# ─────────────────────────────────────────────────────────────────────
# Absence / malformed paths
# ─────────────────────────────────────────────────────────────────────


def test_returns_none_when_no_jsonld() -> None:
    """HTML without any JSON-LD → None (fall-through to LLM)."""
    html = "<html><body><p>Just prose, no structured data.</p></body></html>"
    assert extract_recipe_from_html(html) is None


def test_returns_none_when_jsonld_present_but_not_recipe() -> None:
    """JSON-LD with only non-Recipe entities → None."""
    html = """
    <html><head><script type="application/ld+json">
    {"@context": "https://schema.org", "@type": "Article", "headline": "Not a recipe"}
    </script></head><body></body></html>
    """
    assert extract_recipe_from_html(html) is None


def test_returns_none_when_json_is_malformed() -> None:
    """Malformed JSON in a script block → skip block, return None (no crash)."""
    html = """
    <html><head><script type="application/ld+json">
    { not valid json at all
    </script></head><body></body></html>
    """
    assert extract_recipe_from_html(html) is None


def test_malformed_block_is_skipped_other_block_is_tried() -> None:
    """Two script blocks — one malformed, one valid → use the valid one."""
    html = """
    <html><head>
    <script type="application/ld+json">{broken</script>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Recipe",
      "name": "Recovered",
      "recipeIngredient": ["1 egg"],
      "recipeInstructions": ["Cook."]
    }
    </script>
    </head><body></body></html>
    """
    result = extract_recipe_from_html(html)
    assert result is not None
    assert result["title"] == "Recovered"


def test_returns_none_on_minimum_validity_fail_no_ingredients() -> None:
    """Recipe with title only (no ingredients) → None (fall-through)."""
    html = """
    <html><head><script type="application/ld+json">
    {"@context": "https://schema.org", "@type": "Recipe", "name": "Empty"}
    </script></head><body></body></html>
    """
    assert extract_recipe_from_html(html) is None


def test_returns_none_on_minimum_validity_fail_no_steps() -> None:
    """Recipe with ingredients but no steps → None (fall-through)."""
    html = """
    <html><head><script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Recipe",
      "name": "Half",
      "recipeIngredient": ["1 egg"]
    }
    </script></head><body></body></html>
    """
    assert extract_recipe_from_html(html) is None


def test_empty_html_returns_none() -> None:
    """Empty / whitespace-only HTML → None."""
    assert extract_recipe_from_html("") is None
    assert extract_recipe_from_html("   \n  ") is None


# ─────────────────────────────────────────────────────────────────────
# Field-mapping unit tests (public helpers)
# ─────────────────────────────────────────────────────────────────────


# ---- parse_ingredient_line -----------------------------------------


def test_parse_ingredient_line_metric_german() -> None:
    """Standard German metric line — clean split."""
    r = parse_ingredient_line("500 g Mehl")
    assert r["quantity"] == "500"
    assert r["unit"] == "g"
    assert r["name"] == "Mehl"
    assert r["raw"] == "500 g Mehl"


def test_parse_ingredient_line_comma_decimal() -> None:
    """German comma-decimal: '0,25 l Milch' → quantity=0,25, unit=l."""
    r = parse_ingredient_line("0,25 l Milch")
    assert r["quantity"] == "0,25"
    assert r["unit"] == "l"
    assert r["name"] == "Milch"


def test_parse_ingredient_line_fraction_ascii() -> None:
    """ASCII fraction: '1 1/2 cups flour' → quantity='1 1/2', unit=cups."""
    r = parse_ingredient_line("1 1/2 cups flour")
    assert r["quantity"] == "1 1/2"
    assert r["unit"] == "cups"
    assert r["name"] == "flour"


def test_parse_ingredient_line_simple_fraction() -> None:
    """Simple fraction: '1/2 tsp salt' → quantity=1/2, unit=tsp."""
    r = parse_ingredient_line("1/2 tsp salt")
    assert r["quantity"] == "1/2"
    assert r["unit"] == "tsp"
    assert r["name"] == "salt"


def test_parse_ingredient_line_unicode_fraction() -> None:
    """Unicode fraction: '½ Teelöffel Salz' → quantity=½, unit=Teelöffel."""
    r = parse_ingredient_line("½ Teelöffel Salz")
    assert r["quantity"] == "½"
    assert r["unit"] == "Teelöffel"
    assert r["name"] == "Salz"


def test_parse_ingredient_line_unit_only_no_quantity() -> None:
    """'1 Prise Salz' — quantity=1, unit=Prise, name=Salz."""
    r = parse_ingredient_line("1 Prise Salz")
    assert r["quantity"] == "1"
    assert r["unit"] == "Prise"
    assert r["name"] == "Salz"


def test_parse_ingredient_line_no_unit() -> None:
    """'3 Eier' — quantity=3, unit=None, name=Eier (Eier isn't a unit)."""
    r = parse_ingredient_line("3 Eier")
    assert r["quantity"] == "3"
    assert r["unit"] is None
    assert r["name"] == "Eier"


def test_parse_ingredient_line_fallback_no_numeric() -> None:
    """Line without leading numeric → all-name fallback."""
    r = parse_ingredient_line("Salz und Pfeffer nach Geschmack")
    assert r["quantity"] is None
    assert r["unit"] is None
    assert r["name"] == "Salz und Pfeffer nach Geschmack"
    assert r["raw"] == "Salz und Pfeffer nach Geschmack"


def test_parse_ingredient_line_empty_string_defensive() -> None:
    """Empty / whitespace-only → fallback with empty name."""
    r = parse_ingredient_line("")
    assert r["quantity"] is None
    assert r["unit"] is None
    assert r["name"] == ""


# ---- iso_duration_to_minutes ---------------------------------------


def test_iso_duration_simple_minutes() -> None:
    assert iso_duration_to_minutes("PT30M") == 30


def test_iso_duration_hours_and_minutes() -> None:
    assert iso_duration_to_minutes("PT1H15M") == 75


def test_iso_duration_hours_only() -> None:
    assert iso_duration_to_minutes("PT2H") == 120


def test_iso_duration_zero() -> None:
    assert iso_duration_to_minutes("PT0S") == 0
    assert iso_duration_to_minutes("PT0M") == 0


def test_iso_duration_over_60_minutes() -> None:
    """PT90M normalises to 90 minutes (NOT 1h30m interpretation)."""
    assert iso_duration_to_minutes("PT90M") == 90


def test_iso_duration_with_seconds() -> None:
    """Seconds round down to the nearest minute."""
    assert iso_duration_to_minutes("PT1H30M45S") == 90  # 60+30+0 (45s drops)


def test_iso_duration_invalid_returns_none() -> None:
    assert iso_duration_to_minutes("not-a-duration") is None
    assert iso_duration_to_minutes("") is None
    assert iso_duration_to_minutes(None) is None


# ---- parse_servings ------------------------------------------------


def test_parse_servings_int() -> None:
    assert parse_servings(4) == 4


def test_parse_servings_string_number() -> None:
    assert parse_servings("4") == 4


def test_parse_servings_german_string() -> None:
    assert parse_servings("4 Portionen") == 4


def test_parse_servings_english_string() -> None:
    assert parse_servings("Serves 4") == 4


def test_parse_servings_range() -> None:
    """'4-6 servings' → first number wins (4)."""
    assert parse_servings("4-6 servings") == 4


def test_parse_servings_empty_or_zero() -> None:
    assert parse_servings("") is None
    assert parse_servings(None) is None
    assert parse_servings(0) is None  # clamp to positive at parse-time


def test_parse_servings_list_takes_first() -> None:
    """Schema.org allows ``recipeYield`` as a list → first entry wins."""
    assert parse_servings(["4 Portionen", "4"]) == 4


# ─────────────────────────────────────────────────────────────────────
# Instruction shapes (via end-to-end with inline fixtures)
# ─────────────────────────────────────────────────────────────────────


def _recipe_html(instructions: Any) -> str:
    import json as _json

    payload = {
        "@context": "https://schema.org",
        "@type": "Recipe",
        "name": "X",
        "recipeIngredient": ["1 egg"],
        "recipeInstructions": instructions,
    }
    return (
        '<html><head><script type="application/ld+json">'
        + _json.dumps(payload)
        + "</script></head><body></body></html>"
    )


def test_instructions_prose_string() -> None:
    result = extract_recipe_from_html(_recipe_html("Do it all in one sentence."))
    assert result is not None
    steps = result["components"][0]["steps"]
    assert len(steps) == 1
    assert steps[0]["content"] == "Do it all in one sentence."


def test_instructions_array_of_strings() -> None:
    result = extract_recipe_from_html(_recipe_html(["step one", "step two"]))
    assert result is not None
    steps = result["components"][0]["steps"]
    assert [s["content"] for s in steps] == ["step one", "step two"]


def test_instructions_array_of_howto_steps() -> None:
    result = extract_recipe_from_html(
        _recipe_html(
            [
                {"@type": "HowToStep", "text": "t1"},
                {"@type": "HowToStep", "text": "t2"},
            ]
        )
    )
    assert result is not None
    steps = result["components"][0]["steps"]
    assert [s["content"] for s in steps] == ["t1", "t2"]


def test_instructions_howto_section_nested() -> None:
    result = extract_recipe_from_html(
        _recipe_html(
            [
                {
                    "@type": "HowToSection",
                    "name": "A",
                    "itemListElement": [
                        {"@type": "HowToStep", "text": "a1"},
                        {"@type": "HowToStep", "text": "a2"},
                    ],
                },
                {"@type": "HowToStep", "text": "standalone"},
            ]
        )
    )
    assert result is not None
    steps = result["components"][0]["steps"]
    assert [s["content"] for s in steps] == ["a1", "a2", "standalone"]


def test_instructions_empty_returns_none() -> None:
    """No steps at all → fails minimum-validity (min 1 step)."""
    assert extract_recipe_from_html(_recipe_html([])) is None


# ─────────────────────────────────────────────────────────────────────
# @type shape
# ─────────────────────────────────────────────────────────────────────


def test_type_as_string() -> None:
    result = extract_recipe_from_html(_recipe_html("Do."))
    assert result is not None


def test_type_as_array_including_recipe() -> None:
    import json as _json

    payload = {
        "@context": "https://schema.org",
        "@type": ["NewsArticle", "Recipe"],
        "name": "X",
        "recipeIngredient": ["1 egg"],
        "recipeInstructions": ["Cook."],
    }
    html = (
        '<html><head><script type="application/ld+json">'
        + _json.dumps(payload)
        + "</script></head><body></body></html>"
    )
    result = extract_recipe_from_html(html)
    assert result is not None
    assert result["title"] == "X"


# ─────────────────────────────────────────────────────────────────────
# Security / DoS guards
# ─────────────────────────────────────────────────────────────────────


def test_rejects_oversize_html_payload() -> None:
    """HTML > 5 MiB → None (defence against memory DoS)."""
    # Build a 6 MiB HTML-ish string with a harmless recipe buried in it.
    filler = "<!-- padding -->" * (6 * 1024 * 1024 // 16)
    html = (
        '<html><head><script type="application/ld+json">'
        '{"@type":"Recipe","name":"X","recipeIngredient":["1 egg"],"recipeInstructions":["Cook."]}'
        "</script>" + filler + "</head><body></body></html>"
    )
    # Over the 5 MiB HTML cap → refuse the whole extraction (returns None,
    # the pipeline falls through to the LLM path).
    assert extract_recipe_from_html(html) is None


def test_caps_hostile_ingredient_count() -> None:
    """A JSON-LD blob with 10k ingredients caps at 100 to bound DB bloat."""
    import json as _json

    many_ingredients = [f"{i} g item{i}" for i in range(1, 10_001)]
    payload = {
        "@context": "https://schema.org",
        "@type": "Recipe",
        "name": "Bloat",
        "recipeIngredient": many_ingredients,
        "recipeInstructions": ["Cook."],
    }
    html = (
        '<html><head><script type="application/ld+json">'
        + _json.dumps(payload)
        + "</script></head><body></body></html>"
    )
    result = extract_recipe_from_html(html)
    assert result is not None
    ingredients = result["components"][0]["ingredients"]
    assert len(ingredients) == 100


def test_caps_hostile_step_count() -> None:
    """A JSON-LD blob with 1000 steps caps at 30."""
    import json as _json

    many_steps = [f"step {i}" for i in range(1, 1001)]
    payload = {
        "@context": "https://schema.org",
        "@type": "Recipe",
        "name": "Bloat",
        "recipeIngredient": ["1 egg"],
        "recipeInstructions": many_steps,
    }
    html = (
        '<html><head><script type="application/ld+json">'
        + _json.dumps(payload)
        + "</script></head><body></body></html>"
    )
    result = extract_recipe_from_html(html)
    assert result is not None
    steps = result["components"][0]["steps"]
    assert len(steps) == 30


def test_skips_oversize_jsonld_block() -> None:
    """One giant JSON-LD block > 100 KiB → skipped; no crash."""
    # A 200 KiB JSON-LD value. The BLOCK is too big → skipped.
    giant_name = "X" * (200 * 1024)
    html = f"""
    <html><head>
    <script type="application/ld+json">
    {{"@type":"Recipe","name":"{giant_name}","recipeIngredient":["1 egg"],
      "recipeInstructions":["Cook."]}}
    </script>
    <script type="application/ld+json">
    {{"@type":"Recipe","name":"Small","recipeIngredient":["1 egg"],
      "recipeInstructions":["Cook."]}}
    </script>
    </head><body></body></html>
    """
    result = extract_recipe_from_html(html)
    # The second, in-budget block still produces a recipe.
    assert result is not None
    assert result["title"] == "Small"


# ─────────────────────────────────────────────────────────────────────
# Ingredient ``note`` field — audit-trail handling
# ─────────────────────────────────────────────────────────────────────


def test_ingredient_note_is_none_when_line_parses_with_quantity() -> None:
    """Successfully parsed ingredient lines drop the raw audit-trail.

    Reproduces the pinchofyum.com duplication bug: a recipeIngredient
    line like ``"1 pound ground chicken (could also use pork)"`` is
    cleanly split into quantity/unit/name. Carrying the raw imperial
    line forward as ``note`` causes downstream :func:`_translate_unit`
    (BUG-030) to convert quantity+unit to metric ("454 g") while the
    note still shows the original imperial text, producing duplicated
    ingredient text in the UI. The structured fields already cover
    everything the line conveys, so ``note`` MUST be ``None``.
    """
    import json as _json

    payload = {
        "@context": "https://schema.org",
        "@type": "Recipe",
        "name": "Saucy Gochujang Noodles",
        "recipeIngredient": ["1 pound ground chicken (could also use pork)"],
        "recipeInstructions": ["Cook the noodles."],
    }
    html = (
        '<html><head><script type="application/ld+json">'
        + _json.dumps(payload)
        + "</script></head><body></body></html>"
    )
    result = extract_recipe_from_html(html)
    assert result is not None
    ingredient = result["components"][0]["ingredients"][0]
    assert ingredient["quantity"] == "1"
    assert ingredient["unit"] == "pound"
    assert ingredient["name"] == "ground chicken (could also use pork)"
    assert ingredient["note"] is None
