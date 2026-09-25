#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_seed_html.py — packages ../phase15_seed/seed_2568.json (OUTSIDE the public repo) into
apps-script/_seed.html so the Apps Script backend can read it with
HtmlService.createHtmlOutputFromFile("_seed").getContent().

_seed.html is gitignored: it never gets committed, only pushed to Apps Script via clasp (or read
locally by tools/dev_server.mjs's mock of HtmlService).

Usage: python3 webapp/tools/make_seed_html.py
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]        # webapp/
PROJECT = REPO.parent                              # project เวชภัณฑ์/
SEED_PATH = PROJECT / "phase15_seed" / "seed_2568.json"
OUT_PATH = REPO / "apps-script" / "_seed.html"


def main():
    if not SEED_PATH.exists():
        print(f"ERROR: seed file not found: {SEED_PATH}", file=sys.stderr)
        sys.exit(1)

    data = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    # Minified JSON, restricted to ASCII-safe content: escape "</" so it can never prematurely
    # close the surrounding <script>-less HtmlService file (defense in depth even though there is
    # no <script> tag here — the file's whole content becomes the string HtmlService returns).
    minified = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    minified = minified.replace("</", "<\\/")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(minified, encoding="utf-8")

    size = OUT_PATH.stat().st_size
    print(f"wrote {OUT_PATH} ({size:,} bytes) from {SEED_PATH}")


if __name__ == "__main__":
    main()
