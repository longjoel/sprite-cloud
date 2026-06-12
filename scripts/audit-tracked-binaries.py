#!/usr/bin/env python3
"""Fail if compiled/runtime binaries are tracked in git.

Intentional web image assets are allowlisted. Build outputs, native binaries,
and root-level release artifacts belong in CI/release storage, not source.
"""

from __future__ import annotations

import fnmatch
import os
import subprocess
import sys
from pathlib import Path

MAX_TEXT_FILE_BYTES = 1_048_576

ALLOWLIST_GLOBS = (
    "wwwroot/favicon.ico",
    "wwwroot/img/*.png",
    "wwwroot/img/*.jpg",
    "wwwroot/img/*.jpeg",
    "wwwroot/img/*.webp",
    "wwwroot/img/*.gif",
)

BANNED_GLOBS = (
    "nosebleed-release",
    "nosebleed",
    "*.exe",
    "*.dll",
    "*.so",
    "*.dylib",
    "*.pdb",
    "bin/*",
    "*/bin/*",
    "obj/*",
    "*/obj/*",
    "publish/*",
    "*/publish/*",
)


def git_files() -> list[str]:
    out = subprocess.check_output(["git", "ls-files"], text=True)
    return [line for line in out.splitlines() if line]


def matches_any(path: str, patterns: tuple[str, ...]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def has_nul(path: Path) -> bool:
    with path.open("rb") as handle:
        return b"\0" in handle.read(8192)


def main() -> int:
    repo = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    failures: list[str] = []

    for rel in git_files():
        if matches_any(rel, ALLOWLIST_GLOBS):
            continue

        path = repo / rel
        if not path.exists() or not path.is_file():
            continue

        size = path.stat().st_size
        banned = matches_any(rel, BANNED_GLOBS)
        binary = has_nul(path)
        oversized = size > MAX_TEXT_FILE_BYTES

        if banned or binary or oversized:
            reasons = []
            if banned:
                reasons.append("banned path/extension")
            if binary:
                reasons.append("NUL-byte binary")
            if oversized:
                reasons.append(f">{MAX_TEXT_FILE_BYTES} bytes")
            failures.append(f"{rel} ({size} bytes; {', '.join(reasons)})")

    if failures:
        print("Tracked binary/build artifacts found:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        print("Move these to release artifacts, Docker build stages, /opt, or /srv/storage.", file=sys.stderr)
        return 1

    print("tracked binary audit passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
