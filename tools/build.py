#!/usr/bin/env python3
"""Copy dist/ into the integration, keep manifest.json's version in step, and
write the precompressed siblings Home Assistant serves in place of the raw
files.

`dist/charro-cards.js` stays the file you edit. HACS installs an integration by
copying `custom_components/<domain>/` and nothing else, so the bundle and its
templates have to live in there as well. Run this after any edit to dist/:

    python tools/build.py

aiohttp's static handler looks for a `.br` then a `.gz` next to the file it is
about to serve and hands that over when the browser accepts it, so writing
them here turns a ~210 KB bundle into a ~45 KB download with no code change.
"""

from __future__ import annotations

import gzip
import json
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "dist"
DST = ROOT / "custom_components" / "charro" / "frontend"
MANIFEST = ROOT / "custom_components" / "charro" / "manifest.json"
COMPRESS = {".js", ".json", ".css", ".svg"}


def precompress(path: pathlib.Path) -> str:
    """Write path.gz, and path.br when brotli is available. Returns a summary."""
    raw = path.read_bytes()
    out = [f"{len(raw) / 1024:.0f}K raw"]

    gz = path.with_suffix(path.suffix + ".gz")
    # mtime=0 so an unchanged file produces identical bytes and git sees no diff
    gz.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    out.append(f"{gz.stat().st_size / 1024:.0f}K gz")

    br = path.with_suffix(path.suffix + ".br")
    try:
        import brotli  # type: ignore
    except ImportError:
        # aiohttp prefers .br over .gz over the raw file, so a leftover .br
        # from a machine that HAD brotli would be served in place of this
        # freshly built bundle - stale code, and nothing to show for it.
        # Better no brotli than the wrong brotli.
        if br.exists():
            br.unlink()
            out.append("br removed (brotli not installed)")
        return ", ".join(out)
    br.write_bytes(brotli.compress(raw, quality=11))
    out.append(f"{br.stat().st_size / 1024:.0f}K br")
    return ", ".join(out)


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

    for f in sorted(DST.rglob("*")):
        if f.is_file() and f.suffix in COMPRESS:
            print(f"  {f.relative_to(DST)}: {precompress(f)}")

    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if man.get("version") != version:
        man["version"] = version
        MANIFEST.write_text(json.dumps(man, indent=2) + "\n", encoding="utf-8")
        print(f"manifest.json -> {version}")

    print(f"built {version} into {DST.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
