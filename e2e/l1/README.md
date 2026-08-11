# L1 browser-to-emulator E2E harness (#662 slice 2)

Drives the **full browser path** against a real sc-server: headless Chrome →
LAN player page (127.0.0.1:8787) → WebRTC → nestopia → counter.nes fixture.

## Why this exists

Slice 1 proved the fixture is deterministic at the emulator level (headless
libretro harness). L1 proves the same determinism **through the browser**:
a real WebRTC session, real H.264 encoding, real video decode. It's the
closest we can get to "a human pressed A and the game responded" without a
human.

## What it asserts

1. Library row appears for the fixture game
2. WebRTC connects, the `diagnostics` DataChannel opens and auths
3. Video track attaches at 256×240 and **decoded frames** accumulate
4. Boot frame digit-probes to `0000` — **signature probe, not pixel hash**
   (audio-timing jitter makes full-frame hashing flaky; the counter glyph
   signatures are stable through lossy H.264)
5. A-press (keyboard `x` → libretro id 8 → NES A) flips digits to `0001`
6. `save_state` → counter advances to `0003` → `load_state` → `0001`
7. Close player stops the session; relaunch boots clean to `0000`

## Why Chrome (not Chromium)

sc-server encodes video with GStreamer **H.264**. Playwright's bundled
Chromium ships without proprietary codecs and cannot decode it. Google
Chrome has the H.264 decoder — `channel: 'chrome'` in the Playwright config
uses the system Chrome (preinstalled on GitHub ubuntu-latest runners).
Override with `L1_CHROME_BIN=/path/to/chrome` for other environments.

## Running

```sh
# from repo root, after: cargo build --release -p sc-server -p sc-core
bash e2e/l1/run-l1.sh
```

The runner:
1. preflights tools + port 8787 (fails fast if a server is already up)
2. builds the fixture ROM
3. downloads the nestopia core from buildbot (or honors `CORE=`)
4. starts `sc-server start --standalone` with a temp ROM/core/system dir
5. runs Playwright against `http://127.0.0.1:8787`
6. keeps artifacts in `/tmp/l1-*/artifacts` (server log bearer-redacted)

Env overrides: `SC_SERVER_DIR`, `CORE`, `L1_BASE_URL`, `CHANNEL`,
`L1_CHROME_BIN`, `KEEP_SERVER=1` (leave the server up for debugging).

## CI

`e2e-l1` job in `.github/workflows/ci.yml` (push to main + PRs): builds
sc-server/sc-core, installs cc65 + Node, runs `run-l1.sh`, uploads artifacts
even on failure.

**GStreamer trap:** sc-server's H.264 pipeline needs the `h264parse` element,
which lives in `gstreamer1.0-plugins-bad` — the CI job installs
base/good/ugly/bad explicitly. A bare `plugins-good` install compiles and
runs but silently fails encoder creation (`no element "h264parse"`), which
shows up as "video track never attaches" in the test.
