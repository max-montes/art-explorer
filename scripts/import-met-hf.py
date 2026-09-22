#!/usr/bin/env python3
"""Build a paintings-only curation manifest from the Met HF bulk CSV."""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

DATASET_URL = (
    "https://huggingface.co/datasets/metmuseum/openaccess/"
    "resolve/main/openaccess.csv.gz"
)
DEFAULT_CACHE = Path.home() / ".cache/art-explorer/met-openaccess.csv.gz"
ART_DEPARTMENTS = (
    "african",
    "american",
    "ancient near eastern",
    "asian",
    "brazilian",
    "british",
    "drawings and prints",
    "european",
    "islamic",
    "modern",
    "photographs",
    "american decorative",
    "robert lehman",
)
# Museum-classified as paintings, but these are pages of text with small
# illustrations rather than standalone paintings.
EXCLUDED_OBJECT_NAMES = frozenset({"folio", "manuscript", "initiation card"})


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument(
        "--all",
        action="store_true",
        help="Write every matching painting instead of stopping at --limit.",
    )
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be a positive integer")
    if args.offset < 0:
        parser.error("--offset must be non-negative")
    return args


def ensure_dataset(cache: Path) -> None:
    if cache.exists() and cache.stat().st_size > 0:
        print(f"[Met bulk] using cached dataset {cache}", flush=True)
        return
    cache.parent.mkdir(parents=True, exist_ok=True)
    partial = cache.with_suffix(cache.suffix + ".partial")
    print(f"[Met bulk] downloading {DATASET_URL}", flush=True)
    subprocess.run(
        ["curl", "-L", "--fail", "--retry", "3", "-o", str(partial), DATASET_URL],
        check=True,
    )
    partial.replace(cache)


def text(row: dict[str, str], key: str) -> str:
    return (row.get(key) or "").strip()


def labels(*values: str) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        for label in re.split(r"[;,]", value):
            label = label.strip()
            key = label.lower()
            if label and key not in seen:
                seen.add(key)
                result.append(label)
    return result


def tag_terms(value: str) -> list[str]:
    if not value:
        return []
    try:
        tags = json.loads(value)
    except json.JSONDecodeError:
        return []
    if not isinstance(tags, list):
        return []
    return labels(
        *(
            tag.get("term", "")
            for tag in tags
            if isinstance(tag, dict) and isinstance(tag.get("term"), str)
        )
    )


def integer(value: str) -> int | None:
    try:
        return int(value)
    except ValueError:
        return None


def is_painting(row: dict[str, str]) -> bool:
    object_name = text(row, "objectName").lower()
    if object_name in EXCLUDED_OBJECT_NAMES:
        return False
    classification = text(row, "classification")
    if classification:
        return bool(re.search(r"\bpaintings?\b", classification, re.IGNORECASE))
    # The American Wing leaves classification blank for its whole collection,
    # so fall back to an exact object name. A prefix match would also admit
    # "Painting, miniature" portrait lockets.
    return object_name == "painting"


def to_entry(row: dict[str, str]) -> dict[str, Any] | None:
    if text(row, "isPublicDomain").lower() != "true":
        return None
    if not is_painting(row):
        return None
    department = text(row, "department")
    if not any(name in department.lower() for name in ART_DEPARTMENTS):
        return None
    image_url = text(row, "primaryImage") or text(row, "primaryImageSmall")
    object_url = text(row, "objectURL")
    object_id = text(row, "objectID")
    if not object_id.isdigit() or not image_url or not object_url:
        return None

    title = text(row, "title") or text(row, "objectName") or "Untitled"
    creator = text(row, "artistDisplayName") or "Unknown Creator"
    year = text(row, "objectDate") or "Unknown"
    medium = text(row, "medium")
    culture = text(row, "culture")
    artist_nationality = text(row, "artistNationality")
    associations = tag_terms(text(row, "tags"))
    asset_id = f"met-{object_id}"
    asset = {
        "id": asset_id,
        "type": "artwork",
        "libraryCategory": "artwork",
        "title": title,
        "creator": creator,
        "year": year,
        "culture": culture or None,
        "medium": medium or None,
        "artistNationality": artist_nationality or None,
        "objectBeginDate": integer(text(row, "objectBeginDate")),
        "objectEndDate": integer(text(row, "objectEndDate")),
        "source": {
            "provider": "The Metropolitan Museum of Art",
            "sourceUrl": object_url,
            "mediaUrl": image_url,
            "license": "CC0 / Public Domain",
            "licenseUrl": "https://www.metmuseum.org/policies/terms-and-conditions#art",
        },
        "semantics": {
            "associations": associations,
            "concepts": [],
            "moods": [],
            "subjects": associations,
            "description": " — ".join(filter(None, (title, creator, medium))),
            "narrative": " — ".join(filter(None, (year, culture))),
            "curatorNotes": "Imported from The Met Open Access collection.",
        },
        "ownerId": None,
    }
    return {
        "id": asset_id,
        "source_path": f"met/{object_id}.jpg",
        "decision": "include",
        "exclusion_reason": None,
        "metadata_status": "complete",
        "license_review_status": "approved",
        "asset": asset,
    }


def write_manifest(path: Path, entries: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, "source_root": str(path.parent), "entries": entries}
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def write_checkpoint(
    path: Path, entries: list[dict[str, Any]], offset: int
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "source_root": str(path.parent),
        "offset": offset,
        "entries": entries,
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    args = arguments()
    output = Path(args.output).resolve()
    checkpoint = Path(f"{output}.partial.json")
    entries: list[dict[str, Any]] = []
    offset = args.offset
    if args.resume and checkpoint.exists():
        saved = json.loads(checkpoint.read_text(encoding="utf-8"))
        entries = saved.get("entries", [])
        offset = int(saved.get("offset", offset))
        print(
            f"[Met bulk] resumed at row {offset} with {len(entries)} paintings",
            flush=True,
        )

    ensure_dataset(args.cache)
    csv.field_size_limit(sys.maxsize)
    started = time.monotonic()
    scanned = 0
    with gzip.open(args.cache, "rt", encoding="utf-8", newline="") as stream:
        for row_index, row in enumerate(csv.DictReader(stream)):
            if row_index < offset:
                continue
            scanned += 1
            entry = to_entry(row)
            if entry:
                entries.append(entry)
            current_offset = row_index + 1
            reached_limit = not args.all and len(entries) >= args.limit
            if entry and (len(entries) % 100 == 0 or reached_limit):
                write_checkpoint(
                    checkpoint,
                    entries,
                    current_offset,
                )
                elapsed = max(0.001, time.monotonic() - started)
                target = "all" if args.all else str(args.limit)
                print(
                    f"[Met bulk] row={current_offset}; paintings="
                    f"{len(entries)}/{target}; {scanned / elapsed:.0f} rows/s",
                    flush=True,
                )
            if reached_limit:
                write_manifest(output, entries[: args.limit])
                checkpoint.unlink(missing_ok=True)
                elapsed = time.monotonic() - started
                print(
                    f"[Met bulk] wrote {args.limit} paintings to {output} "
                    f"in {elapsed:.1f}s",
                    flush=True,
                )
                return

    if args.all and entries:
        write_manifest(output, entries)
        checkpoint.unlink(missing_ok=True)
        print(
            f"[Met bulk] wrote all {len(entries)} paintings to {output} "
            f"in {time.monotonic() - started:.1f}s",
            flush=True,
        )
        return

    raise RuntimeError(
        f"Only found {len(entries)} paintings after scanning {scanned} rows"
    )


if __name__ == "__main__":
    main()
