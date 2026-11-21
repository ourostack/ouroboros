#!/usr/bin/env python3
"""Synthetic fixture EPUBs for the replay eval's book cases.

`fixtures.py build <dir>` writes every edition the cases seed and prints one JSON object mapping each label to its
SHA-256. The text is generated from a fixed seed, and every zip entry has a fixed date, so the bytes and hashes are
the same on every machine. Nothing here comes from a real book.

  A   The Harbour Almanac, a scanned copy where each printed line became a paragraph
  A0  edition A as an earlier download saved it: the same text with an older modified date (a different file)
  B   The Harbour Almanac in long paragraphs with no chapter headings and no table of contents
  C   The Harbour Almanac, a clean edition with chapters
  D   A study guide to The Harbour Almanac: readable, but not the book
  E   The Harbour Almanac with chapters and clean paragraphs whose words are scrambled, so only reading it shows it
  X1  Tidewater Recipes, an unrelated readable book already on the shelf
  X2  Lanterns of the North Road, another unrelated readable book already on the shelf
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import io
import random
import sys
import uuid
import zipfile

AUTHOR = "A. Writer"
WORK = "The Harbour Almanac"
FIXED_DATE = (2020, 1, 1, 0, 0, 0)

_SUBJECTS = ["the harbour master", "the ferry", "a gull", "the old pilot", "the tide", "the lamp keeper", "a fishing boat",
             "the north wind", "the market", "a child on the quay", "the lighthouse", "the night watch"]
_VERBS = ["counted", "followed", "watched", "carried", "passed", "remembered", "crossed", "named", "waited for", "mended"]
_OBJECTS = ["the boats at dawn", "a line of rope", "the grey water", "the morning bell", "the salt road", "a lantern",
            "the long pier", "the first frost", "a bundle of letters", "the turning of the year", "the harbour wall"]
_TAILS = ["before the rain came", "as the bell rang twice", "without a word", "while the town slept", "until the light failed",
          "in the usual way", "for the third time that week", "under a low sky"]


def _sentence(rng: random.Random) -> str:
    words = f"{rng.choice(_SUBJECTS)} {rng.choice(_VERBS)} {rng.choice(_OBJECTS)} {rng.choice(_TAILS)}"
    return words[0].upper() + words[1:] + "."


def _paragraph(rng: random.Random, sentences: int) -> str:
    return " ".join(_sentence(rng) for _ in range(sentences))


_GUIDE_OPENERS = ["In this section the reader meets", "Students should notice how the author presents", "A useful question to ask is why the book returns to",
                  "This part of the guide summarises", "Discussion point: consider the role of", "The key theme here is"]
_GUIDE_TOPICS = ["the harbour as a community", "the passing of the seasons", "the lamp keeper's duty", "memory and the sea",
                 "the town's dependence on the tide", "the narrator's quiet voice", "the closing chapters"]
_GUIDE_ENDS = ["and how it prepares the ending.", "in a short written answer.", "with reference to two chapters.",
               "before moving on to the next section.", "as a theme for essays."]


def _guide_paragraph(rng: random.Random, sentences: int) -> str:
    return " ".join(f"{rng.choice(_GUIDE_OPENERS)} {rng.choice(_GUIDE_TOPICS)} {rng.choice(_GUIDE_ENDS)}" for _ in range(sentences))


def _scramble(text: str) -> str:
    """Rotate each letter by 13, so the text keeps its shape but no longer reads as English."""
    out = []
    for ch in text:
        if "a" <= ch <= "z":
            out.append(chr((ord(ch) - 97 + 13) % 26 + 97))
        elif "A" <= ch <= "Z":
            out.append(chr((ord(ch) - 65 + 13) % 26 + 65))
        else:
            out.append(ch)
    return "".join(out)


def _xhtml(title: str, body: str) -> str:
    return ('<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
            f"<head><title>{html.escape(title)}</title></head><body>{body}</body></html>\n")


def _chapters(seed: int, count: int, paragraphs: int, sentences: int, write=_paragraph, heading: str = "Chapter") -> list:
    rng = random.Random(seed)
    return [(f"{heading} {n}", [write(rng, sentences) for _ in range(paragraphs)]) for n in range(1, count + 1)]


def _epub(title: str, docs: list, toc: bool, modified: str = "2021-03-04T10:00:00Z") -> bytes:
    """docs: [(heading or None, body html)]. Every entry is stored uncompressed with a fixed date."""
    manifest = "".join(f'<item id="d{i}" href="d{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(len(docs)))
    spine = "".join(f'<itemref idref="d{i}"/>' for i in range(len(docs)))
    nav_item = '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' if toc else ""
    opf = ('<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
           '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
           f'<dc:identifier id="id">urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, title)}</dc:identifier>'
           f"<dc:title>{html.escape(title)}</dc:title><dc:creator>{AUTHOR}</dc:creator><dc:language>en</dc:language>"
           f'<meta property="dcterms:modified">{modified}</meta></metadata>'
           f"<manifest>{nav_item}{manifest}</manifest><spine>{spine}</spine></package>\n")
    files = [
        ("mimetype", "application/epub+zip"),
        ("META-INF/container.xml", '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                                   '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n'),
        ("OEBPS/content.opf", opf),
    ]
    if toc:
        items = "".join(f'<li><a href="d{i}.xhtml">{html.escape(h)}</a></li>' for i, (h, _) in enumerate(docs) if h)
        files.append(("OEBPS/nav.xhtml", _xhtml("Contents", f'<nav epub:type="toc"><ol>{items}</ol></nav>')))
    files += [(f"OEBPS/d{i}.xhtml", _xhtml(title, body)) for i, (_, body) in enumerate(docs)]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for name, text in files:
            z.writestr(zipfile.ZipInfo(name, FIXED_DATE), text.encode("utf-8"))
    return buf.getvalue()


def _chaptered(title: str, chapters: list, transform=lambda s: s) -> bytes:
    docs = [(h, f"<h2>{html.escape(h)}</h2>" + "".join(f"<p>{html.escape(transform(p))}</p>" for p in ps)) for h, ps in chapters]
    return _epub(title, docs, toc=True)


def _line_broken(title: str, chapters: list, modified: str = "2021-03-04T10:00:00Z") -> bytes:
    """Every printed line of about eight words is its own paragraph, and most lines stop mid-sentence."""
    words = " ".join(p for _, ps in chapters for p in ps).split()
    lines = [" ".join(words[i:i + 8]) for i in range(0, len(words), 8)]
    return _epub(title, [(None, "".join(f"<p>{html.escape(line)}</p>" for line in lines))], toc=False, modified=modified)


def _unstructured(title: str, chapters: list) -> bytes:
    """Good paragraphs, but one document with no headings and no table of contents."""
    return _epub(title, [(None, "".join(f"<p>{html.escape(p)}</p>" for _, ps in chapters for p in ps))], toc=False)


def editions() -> dict:
    """Label -> EPUB bytes."""
    # Every edition is over 100 kB, so a size floor or a small-file penalty does not pick one out.
    almanac = _chapters(1, 14, 30, 4)
    long_almanac = _chapters(1, 24, 30, 4)
    return {
        "A": _line_broken(WORK, almanac),
        "A0": _line_broken(WORK, almanac, modified="2019-08-12T09:30:00Z"),
        "B": _unstructured(WORK, long_almanac),
        "C": _chaptered(WORK, almanac),
        "D": _chaptered(f"Study Guide to {WORK}", _chapters(4, 12, 30, 4, _guide_paragraph, "Part")),
        "E": _chaptered(WORK, almanac, _scramble),
        "X1": _chaptered("Tidewater Recipes", _chapters(2, 14, 30, 4)),
        "X2": _chaptered("Lanterns of the North Road", _chapters(3, 14, 30, 4)),
    }


def build(out_dir: str) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    labels = {}
    for label, data in editions().items():
        with open(os.path.join(out_dir, f"{label}.epub"), "wb") as f:
            f.write(data)
        labels[label] = hashlib.sha256(data).hexdigest()
    return labels


def main(argv: list) -> int:
    if len(argv) != 2 or argv[0] != "build":
        print("usage: fixtures.py build <dir>", file=sys.stderr)
        return 2
    print(json.dumps(build(argv[1]), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
