#!/usr/bin/env python3
"""Pre-release checks for charro-cards.

    python tools/check.py          # exits non-zero if anything fails

Every check here exists because something it catches once shipped broken.
The first one especially: `node --check foo.js` exits 0 on a syntax error,
because Node treats a .js file as CommonJS and defers parsing. Only a .mjs
copy is actually parsed. Several "verified" releases were nothing of the
kind before that was noticed.
"""

from __future__ import annotations

import gzip
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "dist" / "charro-cards.js"
TEMPLATES = ROOT / "dist" / "templates"
FRONTEND = ROOT / "custom_components" / "charro" / "frontend"
MANIFEST = ROOT / "custom_components" / "charro" / "manifest.json"
PY_DIR = ROOT / "custom_components" / "charro"

fails: list[str] = []
notes: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    # detail is the failure explanation, so it only earns space when it failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('' if ok else ' - ' + detail) if detail else ''}")
    if not ok:
        fails.append(name)


def src() -> str:
    return BUNDLE.read_text(encoding="utf-8")


# ----------------------------------------------------------------- checks --


def c_parses() -> None:
    """Real syntax check. Must be .mjs or Node does not parse it at all."""
    if shutil.which("node") is None:
        check("bundle parses", False,
              "Node.js not found on PATH. Install it from nodejs.org - without it "
              "nothing here actually parses the bundle, which is the whole point.")
        return

    text = BUNDLE.read_text(encoding="utf-8")
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)

        # A .js file is parsed as CommonJS, which does not flag a syntax error
        # at all - it defers parsing. So the copy has to be seen as a module.
        # Newer Node infers that from the .mjs extension; Node 18/20 ignores
        # the extension for --check and chokes on `import.meta` instead. The
        # fallback swaps that one token out so the rest of the file still gets
        # a real parse on those versions.
        (tmp / "bundle.mjs").write_text(text, encoding="utf-8")
        r = subprocess.run(["node", "--check", str(tmp / "bundle.mjs")],
                           capture_output=True, text=True)
        err = (r.stderr or "")
        if r.returncode != 0 and "import.meta" in err:
            stub = text.replace("import.meta.url", '"file:///bundle.js"')
            (tmp / "cjs-check.js").write_text(stub, encoding="utf-8")
            r = subprocess.run(["node", "--check", str(tmp / "cjs-check.js")],
                               capture_output=True, text=True)
            ver = subprocess.run(["node", "--version"], capture_output=True, text=True)
            notes.append(
                f"Node {ver.stdout.strip() or '?'} can't --check an ES module; "
                "parsed with import.meta stubbed out instead. Node 22+ checks "
                "the file as written.")
            err = (r.stderr or "")
    check("bundle parses", r.returncode == 0, err.strip()[:300])


def c_methods() -> None:
    """Every this._foo( call resolves to something defined."""
    s = src()
    calls = set(re.findall(r"this\.(_[A-Za-z0-9_]+)\(", s))
    defs = set(re.findall(r"^\s{2,}(?:async\s+)?(_[A-Za-z0-9_]+)\s*\(", s, re.M))
    defs |= set(re.findall(r"(_[A-Za-z0-9_]+)\s*:\s*(?:async\s+)?function", s))
    defs |= set(re.findall(r"(_[A-Za-z0-9_]+)\s*[:=]\s*(?:async\s*)?\(", s))
    missing = sorted(calls - defs)
    check(f"this._method() calls resolve ({len(calls)} calls)", not missing, ", ".join(missing))


def c_defines() -> None:
    """Registration goes through def(), which tolerates a double load."""
    s = src()
    raw = re.findall(r"^customElements\.define\(", s, re.M)
    tags = re.findall(r'^def\("([a-z0-9-]+)"', s, re.M)
    dupes = sorted({t for t in tags if tags.count(t) > 1})
    check("no bare top-level customElements.define", not raw, f"{len(raw)} found")
    check(f"custom element tags unique ({len(tags)} tags)", not dupes, ", ".join(dupes))


def c_templates() -> None:
    """Every template is valid JSON, and every one the cards ask for exists."""
    bad = []
    for f in sorted(TEMPLATES.glob("*.json")):
        try:
            json.loads(f.read_text(encoding="utf-8"))
        except Exception as err:  # noqa: BLE001
            bad.append(f"{f.name}: {err}")
    check("templates are valid JSON", not bad, "; ".join(bad))

    wanted = set(re.findall(r'templateName\(\)\s*\{[^}]*?"([\w.-]+\.json)"', src(), re.S))
    wanted |= set(re.findall(r'return\s+"([\w.-]+\.json)"', src()))
    wanted = {w for w in wanted if w.endswith("-card.json")}
    have = {f.name for f in TEMPLATES.glob("*.json")}
    check(f"templates the cards ask for exist ({len(wanted)})",
          wanted <= have, ", ".join(sorted(wanted - have)))


def c_built() -> None:
    """dist/ and the shipped copy agree - i.e. build.py was run."""
    a, b = BUNDLE, FRONTEND / "charro-cards.js"
    check("frontend/ bundle matches dist/", b.is_file() and a.read_bytes() == b.read_bytes(),
          "run tools/build.py")
    for f in sorted(TEMPLATES.glob("*.json")):
        t = FRONTEND / "templates" / f.name
        if not t.is_file() or t.read_bytes() != f.read_bytes():
            check(f"frontend/templates/{f.name} matches dist/", False, "run tools/build.py")
            return
    check("frontend/templates match dist/", True)


def c_version() -> None:
    m = re.search(r'const VERSION = "([^"]+)"', src())
    v = m.group(1) if m else None
    man = json.loads(MANIFEST.read_text(encoding="utf-8")).get("version")
    check("manifest version matches the bundle", bool(v) and v == man, f"bundle {v}, manifest {man}")


def c_precompressed() -> None:
    """A .br/.gz newer-than-source mismatch would be served INSTEAD of the file."""
    stale = []
    for f in sorted(FRONTEND.rglob("*")):
        if f.suffix in (".gz", ".br"):
            continue
        if not f.is_file():
            continue
        gz = f.with_suffix(f.suffix + ".gz")
        br = f.with_suffix(f.suffix + ".br")
        if gz.is_file():
            try:
                if gzip.decompress(gz.read_bytes()) != f.read_bytes():
                    stale.append(gz.name)
            except Exception:  # noqa: BLE001
                stale.append(gz.name)
        if br.is_file():
            try:
                import brotli  # type: ignore
                if brotli.decompress(br.read_bytes()) != f.read_bytes():
                    stale.append(br.name)
            except ImportError:
                notes.append(f"{br.name} present but brotli not installed - cannot verify")
            except Exception:  # noqa: BLE001
                stale.append(br.name)
    check("precompressed files match their source", not stale, ", ".join(stale))


def c_python() -> None:
    files = sorted(PY_DIR.glob("*.py")) + sorted((ROOT / "tools").glob("*.py"))
    r = subprocess.run([sys.executable, "-m", "py_compile", *map(str, files)],
                       capture_output=True, text=True)
    check("python compiles", r.returncode == 0, (r.stderr or "").strip()[:300])
    for p in ROOT.rglob("__pycache__"):
        shutil.rmtree(p, ignore_errors=True)


def c_json_files() -> None:
    bad = []
    for f in [MANIFEST, ROOT / "hacs.json", PY_DIR / "translations" / "en.json"]:
        try:
            json.loads(f.read_text(encoding="utf-8"))
        except Exception as err:  # noqa: BLE001
            bad.append(f"{f.name}: {err}")
    check("config JSON is valid", not bad, "; ".join(bad))


def main() -> int:
    print(f"charro checks - {ROOT}")
    for fn in (c_parses, c_methods, c_defines, c_templates,
               c_built, c_version, c_precompressed, c_python, c_json_files):
        try:
            fn()
        except Exception as err:  # noqa: BLE001
            check(fn.__name__, False, f"check itself blew up: {err}")
    for n in notes:
        print(f"  note  {n}")
    print()
    if fails:
        print(f"{len(fails)} FAILED: {', '.join(fails)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
