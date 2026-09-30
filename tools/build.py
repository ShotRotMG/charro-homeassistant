#!/usr/bin/env python3
"""Copy dist/ into the integration and keep manifest.json's version in step.

`dist/charro-cards.js` stays the file you edit. HACS installs an integration by
copying `custom_components/<domain>/` and nothing else, so the bundle and its
templates have to live in there as well. Run this after any edit to dist/:

    python tools/build.py
"""

from __future__ import annotations

import json
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "dist"
DST = ROOT / "custom_components" / "charro" / "frontend"
MANIFEST = ROOT / "custom_components" / "charro" / "manifest.json"


def main() -> int:
    bundle = SRC / "charro-cards.js"
    if not bundle.is_file():
        print(f"no {bundle}", file=sys.stderr)
        return 1

    m = re.search(r'const VERSION = "([^"]+)"', bundle.read_text(encoding="utf-8"))
    if not m:
        print("couldn't find VERSION in the bundle", file=sys.stderr)
        return 1
    version = m.group(1)

    # Copy over rather than wiping first: on a synced or sandboxed checkout
    # deleting may not be permitted, and there is nothing here to clean up.
    DST.mkdir(parents=True, exist_ok=True)
    shutil.copy2(bundle, DST / bundle.name)
    if (SRC / "templates").is_dir():
        shutil.copytree(SRC / "templates", DST / "templates", dirs_exist_ok=True)

    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if man.get("version") != version:
        man["version"] = version
        MANIFEST.write_text(json.dumps(man, indent=2) + "\n", encoding="utf-8")
        print(f"manifest.json -> {version}")

    n = sum(1 for _ in DST.rglob("*") if _.is_file())
    print(f"copied {n} file(s) into {DST.relative_to(ROOT)} at {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
