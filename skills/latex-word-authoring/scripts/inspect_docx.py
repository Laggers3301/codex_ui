#!/usr/bin/env python3
"""Read-only, bounded DOCX structural checks; not a visual fidelity validator."""

import argparse
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
R = "{http://schemas.openxmlformats.org/package/2006/relationships}"
MAX_PACKAGE = 64 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_XML = 16 * 1024 * 1024


def parse_xml(data):
    markup = data.replace(b"\0", b"").lower()
    if b"<!doctype" in markup or b"<!entity" in markup:
        raise ValueError("XML DTD/entity declarations are not supported")
    return ET.fromstring(data)


def inspect_docx(path):
    path = Path(path)
    if path.suffix.lower() != ".docx":
        raise ValueError("Expected a .docx file; renaming .doc is not conversion")
    if path.stat().st_size > MAX_PACKAGE:
        raise ValueError("DOCX exceeds the 64 MiB inspection limit")
    with path.open("rb") as stream:
        data = stream.read(MAX_PACKAGE + 1)
    if len(data) > MAX_PACKAGE:
        raise ValueError("DOCX grew beyond the inspection limit")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > 5000 or sum(entry.file_size for entry in entries) > MAX_EXPANDED:
            raise ValueError("DOCX expanded size or entry count exceeds inspection limits")
        if len(set(names)) != len(names):
            raise ValueError("DOCX contains duplicate ZIP entry names")
        if "[Content_Types].xml" not in names or "word/document.xml" not in names:
            raise ValueError("Missing required DOCX package parts")
        if any(entry.flag_bits & 1 for entry in entries):
            raise ValueError("Encrypted ZIP entries are not supported")
        if any("vbaproject" in name.lower() for name in names):
            raise ValueError("Macro-bearing package is not an ordinary DOCX")
        if any(name.startswith(("/", "\\")) or ".." in name.replace("\\", "/").split("/") for name in names):
            raise ValueError("Unsafe ZIP entry path")

        counts = {key: 0 for key in (
            "paragraphs", "tables", "formulas", "drawings", "text_characters",
            "tracked_insertions", "tracked_deletions", "comments", "external_relationships"
        )}
        warnings = []
        if archive.getinfo("[Content_Types].xml").file_size > MAX_XML:
            raise ValueError("Content types XML exceeds inspection limits")
        parse_xml(archive.read("[Content_Types].xml"))
        for entry in entries:
            name = entry.filename
            if not (name.startswith("word/") and name.endswith((".xml", ".rels"))):
                continue
            if entry.file_size > MAX_XML:
                raise ValueError(f"XML part exceeds the 16 MiB inspection limit: {name}")
            root = parse_xml(archive.read(entry))
            if name == "word/document.xml" and root.tag != W + "document":
                raise ValueError("DOCX body has an unexpected root element")
            if name.endswith(".rels"):
                counts["external_relationships"] += sum(
                    item.get("TargetMode", "").lower() == "external"
                    for item in root.iter(R + "Relationship")
                )
                continue
            for key, tag in (
                ("paragraphs", W + "p"), ("tables", W + "tbl"),
                ("formulas", M + "oMath"), ("drawings", W + "drawing"),
                ("tracked_insertions", W + "ins"), ("tracked_deletions", W + "del"),
                ("comments", W + "comment")
            ):
                counts[key] += sum(1 for _ in root.iter(tag))
            counts["text_characters"] += sum(len(item.text or "") for item in root.iter(W + "t"))
            if any(True for _ in root.iter(W + "altChunk")):
                warnings.append("Embedded altChunk content is not covered by these counts")
        if counts["external_relationships"]:
            warnings.append("External relationships present; inspection did not fetch them")
        return {
            "file": path.name, "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data), "parts": len(entries), "counts": counts,
            "warnings": warnings,
            "limitations": "Structure/counts only; not proof of visual fidelity, semantic correctness, or editor compatibility"
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document", type=Path)
    parser.add_argument("--baseline", type=Path)
    args = parser.parse_args()
    try:
        result = inspect_docx(args.document)
        if args.baseline:
            baseline = inspect_docx(args.baseline)
            result["baseline_sha256"] = baseline["sha256"]
            result["count_changes"] = {
                key: {"before": baseline["counts"][key], "after": value}
                for key, value in result["counts"].items() if value != baseline["counts"][key]
            }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, zipfile.BadZipFile, ET.ParseError, RuntimeError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
