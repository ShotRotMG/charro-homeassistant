#!/usr/bin/env python3
"""Cut a release: push, tag, publish, and tell you where to click next.

    python tools/release.py            # do it
    python tools/release.py --dry-run  # say what it would do

Four fiddly steps collapsed into one. It refuses rather than guesses: a
failing check, a dirty tree, a version that disagrees with the manifest or
a tag that already exists all stop it before anything leaves the machine.

Nothing here stores a credential. For the push it uses whatever git already
uses. For the release it asks, in order:

  1. the `gh` CLI, if it is installed and logged in - then there is nothing
     to set up at all;
  2. `.gh_token`, if you have put one there (it is gitignored);
  3. the credential Git Credential Manager already holds for github.com,
     which on Windows is the one you signed in with.

If none of those answer, it says so and does nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE = os.path.join(ROOT, "dist", "charro-cards.js")
MANIFEST = os.path.join(ROOT, "custom_components", "charro", "manifest.json")
REPO = "ShotRotMG/charro-homeassistant"
HACS_URL = "https://home.charro.cc/hacs/repository/1389615192"
RESTART_URL = "https://home.charro.cc/config/dashboard"


def run(*args, **kw):
    return subprocess.run(args, cwd=ROOT, text=True, capture_output=True, **kw)


def die(msg: str) -> None:
    print(f"\n  STOP  {msg}\n")
    raise SystemExit(1)


def version() -> str:
    with open(BUNDLE, encoding="utf-8") as fh:
        m = re.search(r'const VERSION = "([^"]+)"', fh.read())
    if not m:
        die("no VERSION in dist/charro-cards.js")
    v = m.group(1)
    with open(MANIFEST, encoding="utf-8") as fh:
        mv = json.load(fh).get("version")
    if mv != v:
        die(f"the bundle says {v} and the manifest says {mv}. Run tools/build.py.")
    return v


def preflight(v: str) -> str:
    """Everything that should stop a release, checked before anything moves."""
    checks = run(sys.executable, os.path.join("tools", "check.py"))
    if checks.returncode != 0:
        print(checks.stdout or checks.stderr)
        die("tools/check.py failed. Nothing was pushed.")
    print("  ok    checks pass")

    if run("git", "status", "--porcelain").stdout.strip():
        die("the working tree is dirty. Commit first - a release should point "
            "at a commit, not at whatever happened to be on disk.")
    print("  ok    tree is clean")

    if run("git", "rev-parse", "-q", "--verify", f"refs/tags/{v}").returncode == 0:
        die(f"tag {v} already exists. Bump the version, or delete the tag.")
    ls = run("git", "ls-remote", "--tags", "origin", v).stdout.strip()
    if ls:
        die(f"tag {v} is already on the remote. Bump the version.")
    print(f"  ok    {v} is a new version")

    sha = run("git", "rev-parse", "HEAD").stdout.strip()
    subject = run("git", "log", "-1", "--format=%s").stdout.strip()
    print(f"  ok    HEAD is {sha[:8]} — {subject}")
    return sha


def notes() -> str:
    """The commit body makes the release notes - it is already written."""
    body = run("git", "log", "-1", "--format=%b").stdout.strip()
    # the attribution trailers belong in the commit, not on the release page
    keep = [ln for ln in body.splitlines()
            if not ln.startswith(("Co-Authored-By:", "Claude-Session:"))]
    return "\n".join(keep).strip()


def token() -> tuple[str, str] | tuple[None, None]:
    """A credential, from wherever one already is. Never printed."""
    path = os.path.join(ROOT, ".gh_token")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            t = fh.read().strip()
        if t:
            return t, ".gh_token"
    got = run("git", "credential", "fill", input="protocol=https\nhost=github.com\n\n")
    for line in got.stdout.splitlines():
        if line.startswith("password="):
            return line[9:], "git credential manager"
    return None, None


def publish(v: str, sha: str, body: str, dry: bool) -> None:
    if dry:
        print(f"  dry   would create release {v} at {sha[:8]}")
        return

    if shutil.which("gh"):
        args = ["gh", "release", "create", v, "--repo", REPO, "--title", v,
                "--target", sha, "--notes", body or v]
        out = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
        if out.returncode == 0:
            print(f"  ok    release {v} published (gh)")
            return
        print(f"  ..    gh didn't take it ({out.stderr.strip()[:120]}), trying the API")

    tok, where = token()
    if not tok:
        die("no way to authenticate the release. Either install the GitHub CLI "
            "and run `gh auth login`, or put a fine-grained token with "
            "Contents: read and write into .gh_token (it is gitignored). "
            f"The push already happened — only the release is missing. "
            f"You can make it by hand at "
            f"https://github.com/{REPO}/releases/new?tag={v}")

    payload = json.dumps({
        "tag_name": v, "name": v, "target_commitish": sha,
        "body": body or v, "draft": False, "prerelease": False,
    }).encode()
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/releases", data=payload,
        headers={"Authorization": f"Bearer {tok}",
                 "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json",
                 "User-Agent": "charro-release"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")[:300]
        die(f"GitHub refused the release ({err.code}) using the credential from "
            f"{where}: {detail}")
    print(f"  ok    release {v} published ({where})")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="check everything and say what would happen")
    args = ap.parse_args()

    v = version()
    print(f"\ncharro release {v}\n")
    sha = preflight(v)

    if args.dry_run:
        print(f"  dry   would push main and release {v}\n")
        return

    push = run("git", "push", "origin", "HEAD:main")
    if push.returncode != 0:
        die(f"push failed: {(push.stderr or push.stdout).strip()[:300]}")
    print("  ok    pushed to origin/main")

    publish(v, sha, notes(), False)

    print(f"""
Done. Two clicks left, in this order:

  1. {HACS_URL}
     ⋮ menu → Update information, then Redownload, pick {v}

  2. {RESTART_URL}
     only if this release changed anything under custom_components/
     (Python). A frontend-only change needs a hard refresh, not a restart.
""")


if __name__ == "__main__":
    main()
