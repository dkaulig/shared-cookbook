"""COVER-0 slice A — JSON-LD ``image`` flattener for blog candidates.

schema.org Recipe's ``image`` field is polymorphic — it can be a single
URL string, an array of strings, a single ``ImageObject`` dict with a
``url`` key, or an array of such dicts. The flattener consolidates all
four shapes into a ``list[str]`` capped at 6 entries; the ordering is
preserved so ``[0]`` wins as the default cover.
"""

from __future__ import annotations

from extractor.pipeline.blog import flatten_jsonld_image_candidates


def test_jsonld_image_string_returns_single_entry_list() -> None:
    """``image: "https://…"`` → ``[url]``."""
    candidates = flatten_jsonld_image_candidates({"image": "https://cdn.example/a.jpg"})
    assert candidates == ["https://cdn.example/a.jpg"]


def test_jsonld_image_array_of_strings_preserves_order() -> None:
    """``image: [a, b, c]`` → ``[a, b, c]`` — order preserved so ``[0]``
    is the default cover (first-image-wins convention)."""
    candidates = flatten_jsonld_image_candidates(
        {
            "image": [
                "https://cdn.example/a.jpg",
                "https://cdn.example/b.jpg",
                "https://cdn.example/c.jpg",
            ]
        }
    )
    assert candidates == [
        "https://cdn.example/a.jpg",
        "https://cdn.example/b.jpg",
        "https://cdn.example/c.jpg",
    ]


def test_jsonld_image_object_with_url_returns_single_entry() -> None:
    """``image: { url: "…" }`` → ``[url]`` — the schema.org ImageObject
    form collapses to its URL."""
    candidates = flatten_jsonld_image_candidates(
        {"image": {"url": "https://cdn.example/single.jpg", "width": 1280}}
    )
    assert candidates == ["https://cdn.example/single.jpg"]


def test_jsonld_image_array_of_objects_returns_url_list() -> None:
    """``image: [{ url: a }, { url: b }]`` → ``[a, b]``."""
    candidates = flatten_jsonld_image_candidates(
        {
            "image": [
                {"url": "https://cdn.example/a.jpg"},
                {"url": "https://cdn.example/b.jpg"},
            ]
        }
    )
    assert candidates == [
        "https://cdn.example/a.jpg",
        "https://cdn.example/b.jpg",
    ]


def test_jsonld_image_missing_returns_empty_list() -> None:
    """No ``image`` key → ``[]``. Callers treat the empty list as
    "nothing to pick from"."""
    candidates = flatten_jsonld_image_candidates({"name": "A recipe"})
    assert candidates == []


def test_jsonld_image_none_returns_empty_list() -> None:
    """Explicit ``None`` value → ``[]``."""
    candidates = flatten_jsonld_image_candidates({"image": None})
    assert candidates == []


def test_jsonld_image_caps_at_6_entries() -> None:
    """A 10-entry ``image`` array truncates to 6 — per-import memory
    bound (slice A only returns URLs, no fetch; the cap is the
    hand-off contract to slice B's backend-side CandidateAttacher)."""
    many = [f"https://cdn.example/img-{i}.jpg" for i in range(10)]
    candidates = flatten_jsonld_image_candidates({"image": many})
    assert len(candidates) == 6
    assert candidates == many[:6]


def test_jsonld_image_huge_array_short_circuits_at_cap() -> None:
    """Security: a hostile JSON-LD blog could plant a 10_000-entry
    ``image`` array. The flattener must abort once the cap is reached
    rather than walking the whole list — otherwise we'd use 10k-entry
    set + list memory per import."""
    huge = [f"https://cdn.example/img-{i}.jpg" for i in range(10_000)]
    candidates = flatten_jsonld_image_candidates({"image": huge})
    # Output bounded at the cap.
    assert len(candidates) == 6
    # First 6 entries survive in order; the rest never touched.
    assert candidates == huge[:6]


def test_jsonld_image_array_drops_non_string_non_object_entries() -> None:
    """An ``image`` array with mixed garbage (ints, None, lists) keeps
    only the string / object-with-url entries in input order."""
    candidates = flatten_jsonld_image_candidates(
        {
            "image": [
                "https://cdn.example/a.jpg",
                None,
                42,
                {"url": "https://cdn.example/b.jpg"},
                ["nested"],
                {"no_url_here": "ignored"},
            ]
        }
    )
    assert candidates == [
        "https://cdn.example/a.jpg",
        "https://cdn.example/b.jpg",
    ]


def test_jsonld_image_empty_string_dropped() -> None:
    """Whitespace-only / empty URLs are dropped — the UI would render a
    broken tile and the .NET allowlist would reject them anyway."""
    candidates = flatten_jsonld_image_candidates(
        {
            "image": [
                "",
                "   ",
                "https://cdn.example/a.jpg",
            ]
        }
    )
    assert candidates == ["https://cdn.example/a.jpg"]


def test_jsonld_image_dedupes_within_candidates() -> None:
    """The same URL repeated in the ``image`` array collapses to a
    single candidate — the picker UI would show two identical tiles
    otherwise."""
    candidates = flatten_jsonld_image_candidates(
        {
            "image": [
                "https://cdn.example/a.jpg",
                "https://cdn.example/a.jpg",
                "https://cdn.example/b.jpg",
            ]
        }
    )
    assert candidates == [
        "https://cdn.example/a.jpg",
        "https://cdn.example/b.jpg",
    ]
