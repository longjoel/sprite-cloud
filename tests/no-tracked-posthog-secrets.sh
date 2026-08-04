#!/usr/bin/env bash
set -euo pipefail

# Guards against leaking PostHog credentials or hosts into tracked files.
# PostHog project API keys look like `phc_<32 chars>`. A real key must never
# appear in the tree: the SDK is env-gated (NEXT_PUBLIC_POSTHOG_KEY /
# NEXT_PUBLIC_POSTHOG_HOST at build time) and the deploy workflow supplies
# values from GitHub secrets. This script fails CI if a key or a hardcoded
# host sneaks into any tracked file.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

python3 - <<'PY'
from pathlib import Path
import re
import subprocess
import sys

ENV_EXAMPLE = Path("sc-web/.env.example")
EXPECTED_LINES = [
    "NEXT_PUBLIC_POSTHOG_KEY=",
    "NEXT_PUBLIC_POSTHOG_HOST=",
]
for expected in EXPECTED_LINES:
    if expected not in ENV_EXAMPLE.read_text().splitlines():
        print(f"sc-web/.env.example must contain '{expected}' (empty default)", file=sys.stderr)
        sys.exit(1)

# A real PostHog project key: phc_ followed by 32 hex chars. The pattern also
# matches base64-ish variants (PostHog keys are hex, but be generous).
posthog_key = re.compile(r"\bphc_[A-Za-z0-9]{16,}\b")
# A hardcoded analytics host: any non-empty, non-placeholder value assigned to
# the POSTHOG_HOST env var in any tracked file. Self-hosted PostHog can live
# on any domain, so we must not assume a posthog.com suffix — ANY concrete
# host here is a leak. Placeholder forms (${VAR:-}, ${{ secrets.X }}) are the
# documented empty-default contracts and are allowed.
posthog_host = re.compile(
    r"NEXT_PUBLIC_POSTHOG_HOST\s*(?::|=)\s*\"?([^\s\"']+)\"?",
    re.IGNORECASE,
)
allowed_hosts = {
    # Documented placeholders only — a real host here is a leak.
    "https://us.i.posthog.com",
    "https://eu.i.posthog.com",
}


def is_placeholder(value: str) -> bool:
    return value.startswith("${") or value.startswith("${{") or value == ""

scanned_suffixes = {
    ".bash",
    ".conf",
    ".css",
    ".env",
    ".example",
    ".html",
    ".js",
    ".json",
    ".md",
    ".mjs",
    ".rs",
    ".service",
    ".sh",
    ".svelte",
    ".toml",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
}


def should_scan(path: Path) -> bool:
    name = path.name.lower()
    return (
        path.suffix.lower() in scanned_suffixes
        or "compose" in name
        or name == "dockerfile"
    )


def find_violations(text: str) -> list[str]:
    found = []
    for match in posthog_key.finditer(text):
        found.append(f"PostHog project key {match.group(0)[:8]}…")
    for match in posthog_host.finditer(text):
        host = match.group(1)
        if host not in allowed_hosts and not is_placeholder(host):
            found.append(f"hardcoded PostHog host {host}")
    return found


# Mutation fixtures exercise both key and host detection.
mutation_files = {
    Path("synthetic-ph.js"): "const k = 'phc_0123456789abcdef0123456789abcdef';",
    Path("synthetic-ph.env"): "NEXT_PUBLIC_POSTHOG_KEY=phc_0123456789abcdef0123456789abcdef",
    Path("synthetic-ph.yml"): "NEXT_PUBLIC_POSTHOG_HOST: https://analytics.example-vps.com",
    Path("synthetic-ph.md"): "set NEXT_PUBLIC_POSTHOG_HOST=https://leak.example.com in your env",
}
for path, contents in mutation_files.items():
    if not should_scan(path) or not find_violations(contents):
        print(f"posthog scanner mutation fixture escaped detection: {path}", file=sys.stderr)
        sys.exit(1)

# Allowed fixtures must NOT trip the scanner.
safe_fixtures = [
    "NEXT_PUBLIC_POSTHOG_KEY=",
    "NEXT_PUBLIC_POSTHOG_HOST=",
    "NEXT_PUBLIC_POSTHOG_HOST: ${NEXT_PUBLIC_POSTHOG_HOST:-}",
    'NEXT_PUBLIC_POSTHOG_HOST="${{ secrets.POSTHOG_HOST }}"',
    "https://us.i.posthog.com",
    "https://eu.i.posthog.com",
]
for fixture in safe_fixtures:
    if find_violations(fixture):
        print(f"posthog scanner rejected a safe fixture: {fixture!r}", file=sys.stderr)
        sys.exit(1)

tracked = subprocess.run(
    ["git", "ls-files", "-z"],
    check=True,
    stdout=subprocess.PIPE,
).stdout.split(b"\0")
violations = []
for encoded_path in tracked:
    if not encoded_path:
        continue
    path = Path(encoded_path.decode())
    if path == Path("tests/no-tracked-posthog-secrets.sh") or not should_scan(path):
        continue
    try:
        text = path.read_text()
    except (UnicodeDecodeError, OSError):
        continue
    for violation in find_violations(text):
        violations.append(f"{path}: {violation}")

if violations:
    print("\n".join(violations), file=sys.stderr)
    print(
        "PostHog credentials/hosts must come from build-time env (NEXT_PUBLIC_*) "
        "or GitHub secrets — never from tracked files.",
        file=sys.stderr,
    )
    sys.exit(1)

print("tracked PostHog secret contract: PASS")
PY
