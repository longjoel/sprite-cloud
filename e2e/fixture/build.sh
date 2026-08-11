#!/usr/bin/env bash
# e2e/fixture/build.sh — reproducible build of the E2E fixture.
#
# Builds:
#   1. rom/counter.nes  — the NES homebrew ROM (ca65 + ld65 via cl65)
#   2. harness/counter_harness — the headless libretro test harness (gcc)
#   3. out/audio/tone.nes + out/audio/gb-tone.gb — mono-channel tone ROMs
#      for the audio probe (#686; see audio/README.md for the matrix)
#
# Determinism: cc65 2.19 + the same source produce the same .nes bytes.
# The harness build is deterministic by construction (no timestamps).
#
# Usage: build.sh [out_dir]
#   out_dir defaults to e2e/fixture/out/

set -euo pipefail

cd "$(dirname "$0")"

OUT="${1:-out}"
mkdir -p "$OUT/rom" "$OUT/harness"

echo "[build] assembling counter.nes (cl65 -t nes)..."
cl65 -t nes -o "$OUT/rom/counter.nes" rom/counter.s

echo "[build] compiling counter_harness (gcc -ldl -lm -O2)..."
gcc -o "$OUT/harness/counter_harness" harness/counter_harness.c \
    -Iharness -ldl -lm -O2

# ── Audio fixtures (#686) — deterministic mono-channel tone ROMs ─────
mkdir -p "$OUT/audio"
echo "[build] assembling audio/tone.nes (ca65 + ld65, 16 KB NROM)..."
ca65 -o "$OUT/audio/tone.o" audio/tone.s
ld65 -C audio/nes16.cfg -o "$OUT/audio/tone.nes" "$OUT/audio/tone.o"
echo "[build] assembling audio/gb-tone.gb (python3)..."
python3 audio/make-gb-tone.py "$OUT/audio/gb-tone.gb"

echo "[build] done:"
ls -la "$OUT/rom/counter.nes" "$OUT/harness/counter_harness" \
    "$OUT/audio/tone.nes" "$OUT/audio/gb-tone.gb"
