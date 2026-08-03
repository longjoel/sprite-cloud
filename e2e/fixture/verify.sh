#!/usr/bin/env bash
# e2e/fixture/verify.sh — determinism + behavior verification for the E2E fixture.
#
# Proves (assertion-fails loud on any violation):
#   1. BOOT DETERMINISM  — two no-input runs hash identically
#   2. INPUT DETERMINISM  — two A-press runs hash identically
#   3. INPUT RESPONSE     — A-press hash != no-input hash
#   4. BUTTON BEHAVIOR    — A increments (0001), B wraps to 9999,
#                           Start resets to 0000
#
# Prints PASS/FAIL per check; exits nonzero on any failure.
# Run from e2e/fixture/ after build.sh (needs out/ + a nestopia core).

set -euo pipefail
cd "$(dirname "$0")"

CORE="${CORE:-/home/longjoel/.local/share/sprite-cloud/cores/nestopia_libretro.so}"
HARNESS="out/harness/counter_harness"
ROM="out/rom/counter.nes"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ ! -x "$HARNESS" ]; then
    echo "FAIL: harness not built — run build.sh first" >&2
    exit 1
fi
if [ ! -f "$ROM" ]; then
    echo "FAIL: ROM not built — run build.sh first" >&2
    exit 1
fi
if [ ! -f "$CORE" ]; then
    echo "FAIL: nestopia core not found at $CORE — set CORE=/path/to/nestopia_libretro.so" >&2
    exit 1
fi

fails=0
check() { # check <name> <cond>
    if [ "$2" = "PASS" ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; fails=$((fails+1)); fi
}

echo "[1/4] boot determinism (two no-input runs)..."
"$HARNESS" "$CORE" "$ROM" 120 -1 "$WORK/no1.ppm" a >/dev/null 2>&1
"$HARNESS" "$CORE" "$ROM" 120 -1 "$WORK/no2.ppm" a >/dev/null 2>&1
H1=$(sha256sum "$WORK/no1.ppm" | cut -d' ' -f1)
H2=$(sha256sum "$WORK/no2.ppm" | cut -d' ' -f1)
check "no-input hash stable ($H1)" "$([ "$H1" = "$H2" ] && echo PASS || echo FAIL)"

echo "[2/4] input determinism (two A-press runs)..."
"$HARNESS" "$CORE" "$ROM" 120 60 "$WORK/ap1.ppm" a >/dev/null 2>&1
"$HARNESS" "$CORE" "$ROM" 120 60 "$WORK/ap2.ppm" a >/dev/null 2>&1
H3=$(sha256sum "$WORK/ap1.ppm" | cut -d' ' -f1)
H4=$(sha256sum "$WORK/ap2.ppm" | cut -d' ' -f1)
check "A-press hash stable ($H3)" "$([ "$H3" = "$H4" ] && echo PASS || echo FAIL)"

echo "[3/4] input response (A-press changes the frame)..."
check "A-press != no-input" "$([ "$H3" != "$H1" ] && echo PASS || echo FAIL)"

echo "[4/4] button behaviors (digit decode via pixel probe)..."
"$HARNESS" "$CORE" "$ROM" 120 60 "$WORK/b.ppm" b >/dev/null 2>&1
"$HARNESS" "$CORE" "$ROM" 120 60 "$WORK/start.ppm" start >/dev/null 2>&1

python3 - "$WORK" <<'PYEOF'
import sys, hashlib
from PIL import Image
work = sys.argv[1]

def digits(path):
    im = Image.open(path).convert("L")
    px = im.load()
    out = []
    for t in range(4):
        # classify the 8x8 tile by counting lit pixels per row
        rows = []
        for y in range(8, 16):
            n = sum(1 for x in range(80+t*8, 88+t*8) if px[x,y] > 128)
            rows.append(n)
        # glyph row signatures (lit-pixel counts per 8px row):
        # 0 = $70,$88×5,$70,$00 -> [3,2,2,2,2,2,3,0]
        # 1 = $10,$30,$10×4,$38,$00 -> [1,2,1,1,1,1,3,0]
        # 9 = $70,$88,$88,$78,$08,$88,$70,$00 -> [3,2,2,4,1,2,3,0]
        if rows == [3,2,2,2,2,2,3,0]: out.append("0")
        elif rows == [1,2,1,1,1,1,3,0]: out.append("1")
        elif rows == [3,2,2,4,1,2,3,0]: out.append("9")
        else: out.append("?")
    return "".join(out)

checks = [
    ("no-input shows 0000", digits(f"{work}/no1.ppm") == "0000"),
    ("A-press shows 0001",  digits(f"{work}/ap1.ppm") == "0001"),
    ("B-press wraps to 9999", digits(f"{work}/b.ppm") == "9999"),
    ("Start resets to 0000", digits(f"{work}/start.ppm") == "0000"),
]
for name, ok in checks:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok: sys.exit(1)
PYEOF
rc=$?
if [ $rc -ne 0 ]; then fails=$((fails+1)); fi

echo
if [ "$fails" -eq 0 ]; then
    echo "ALL CHECKS PASSED"
    exit 0
else
    echo "$fails CHECK(S) FAILED"
    exit 1
fi
