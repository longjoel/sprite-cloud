# Games Vault — Code Quality Cleanup Plan

> **For Hermes:** Execute task-by-task. Each task is self-contained with exact paths and commands.

**Goal:** Make the codebase pretty, small, and easy to comprehend — remove dead code, split god files, fix clippy warnings, and reduce unwrap() usage across Rust + TypeScript.

**Architecture:** Three-phase attack. Phase 1: low-risk mechanical cleanup (dead code removal, clippy auto-fixes). Phase 2: structural refactors (split god files into focused modules). Phase 3: hygiene (unwrap → expect, TS component splits). Each phase is independently committable.

**Tech Stack:** Rust (cargo workspace: gv-server, gv-worker, libretro-runner), TypeScript/Next.js (gv-web)

**Baseline:** 33 Rust files, 5.8K Rust LOC. 4 god files >800 lines. 11 clippy warnings. 29 unwrap() in production code. 5 TS god files >400 lines. TSC clean. Git clean on `main`.

---

## Phase 1: Mechanical Cleanup (low risk, high impact)

### Task 1: Run clippy --fix (auto-applied suggestions)

**Objective:** Apply 4 auto-fixable clippy suggestions to gv-server.

**Files:**
- `gv-server/src/dat.rs`
- `gv-server/src/local/api.rs`
- `gv-server/src/local/poller.rs`

**Step 1: Run clippy --fix**

```bash
cd /root/projects/games-vault
cargo clippy --fix --lib -p gv-server --allow-dirty --allow-staged
```

**Step 2: Verify zero warnings from those lints**

```bash
cargo clippy -p gv-server 2>&1 | grep -E 'manual_strip|collapsible_if'
```

Expected: no output (these specific warnings are gone).

**Step 3: Verify build**

```bash
cargo check -p gv-server
```

Expected: exit 0, no new warnings.

**Step 4: Commit**

```bash
git add gv-server/src/dat.rs gv-server/src/local/api.rs gv-server/src/local/poller.rs
git commit -m "chore: apply clippy --fix (collapsible_if, manual_strip)"
```

---

### Task 2: Remove dead code from gv-server/src/commands.rs

**Objective:** Delete 5 dead functions and 1 unused import. These were left behind when gv-server became a library-only crate (no standalone binary startup path).

**Files:**
- `gv-server/src/commands.rs`

**Dead items to remove:**

| Line | Item | Reason |
|------|------|--------|
| 12 | `use crate::platform;` | unused import |
| 18–73 | `cmd_pair()` | never called |
| 75–735 | `cmd_start()` | never called |
| 737–768 | `internal_worker_url()` | never called |
| 892–958 | `validate_prerequisites()` | never called |
| 960–971 | `shutdown_signal()` (first copy) | never called |
| 973–end | `shutdown_signal()` (duplicate) | never called, also a duplicate |

**Step 1: Remove unused import**

Patch `gv-server/src/commands.rs`:
- Remove line 12: `use crate::platform;`

**Step 2: Remove dead functions**

Delete the 5 dead functions (lines 18–73, 75–735, 737–768, 892–958, 960–end). The live functions are: `release_manifest_path`, `load_release_manifest`, `normalize_binary_path`, `component_version`, `collect_component_versions`, `collect_metadata`.

**Step 3: Verify build**

```bash
cargo check -p gv-server
```

Expected: exit 0, no warnings about dead_code or unused_imports from commands.rs.

**Step 4: Commit**

```bash
git add gv-server/src/commands.rs
git commit -m "chore: remove dead code from commands.rs (5 fns, 1 import)"
```

---

### Task 3: Remove dead PeerLifecycle::Authenticating variant

**Objective:** Delete the never-constructed enum variant.

**Files:**
- `gv-worker/src/main_body/mod.rs:99-108`

**Step 1: Remove the variant**

Lines 99-108 currently:
```rust
enum PeerLifecycle {
    Authenticating { since: std::time::Instant },
    // ... other variants
}
```

Delete `Authenticating { since: std::time::Instant },` and its trailing comma. If it's the only variant, remove the whole enum (but check first).

**Step 2: Remove needless_update**

Line 425: `..Default::default()` — all fields are already specified. Remove the line.

**Step 3: Verify**

```bash
cargo check -p gv-worker
```

Expected: exit 0, no dead_code warning for Authenticating.

**Step 4: Commit**

```bash
git add gv-worker/src/main_body/mod.rs
git commit -m "chore: remove dead PeerLifecycle::Authenticating variant + needless_update"
```

---

### Task 4: Audit and clean `#[allow(dead_code)]` suppressions

**Objective:** 12 suppressions total. For each: verify it's still warranted, remove if stale, add explanatory comment if real API contract.

**Files:**
- `gv-server/src/worker.rs:189` — `ensure_core_for_test` (used in tests, keep)
- `gv-server/src/dat.rs:42,44,47` — DAT format model fields (API contract, keep)
- `gv-server/src/gv_web.rs:27,88,90,175` — parsed-from-JSON fields + unused method (check each)
- `gv-worker/src/core_bridge.rs:24,26` — `width` on VideoFrame (check if read)
- `gv-worker/src/main_body/mod.rs:171` — `AppState` field (check what it is)
- `libretro-runner/src/runner.rs:103` — `retro_run` (FFI function pointer, keep)

**Step 1: For each suppression, search for usage**

```bash
# gv-server/src/gv_web.rs:27 — user_id
rg '\.user_id' gv-server/src/ gv-web/app/ gv-web/lib/

# gv-server/src/gv_web.rs:88 — lease_expires_at
rg 'lease_expires_at' gv-server/src/ gv-web/

# gv-server/src/gv_web.rs:175 — verify method
rg 'verify' gv-server/src/gv_web.rs

# gv-worker/src/core_bridge.rs:24 — width
rg '\.width' gv-worker/src/

# gv-worker/src/main_body/mod.rs:171 — the suppressed field
read_file gv-worker/src/main_body/mod.rs offset=168 limit=15
```

**Step 2: Remove stale suppressions**

Any field that's truly never read → delete the field and its suppression. Any field that's part of an API contract → keep suppression but add comment: `// API contract: parsed from JSON but not read server-side`.

**Step 3: Verify**

```bash
cargo check --workspace
```

Expected: exit 0, no new dead_code warnings.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: audit dead_code suppressions — remove stale, annotate API contracts"
```

---

## Phase 2: God File Splits (Rust)

### Task 5: Extract pixel conversion from libretro-runner/src/runner.rs

**Objective:** Move 6 pixel conversion functions (~130 lines) into `runner/pixels.rs`. They have zero dependencies on the `Core` struct.

**Files:**
- Create: `libretro-runner/src/runner/pixels.rs`
- Modify: `libretro-runner/src/runner/mod.rs`

**Functions to extract (lines 832–990):**
- `xrgb8888_to_rgb24`
- `rgb565_to_rgb24`
- `xrgb8888_to_rgb24_strided`
- `rgb565_to_rgb24_strided`
- `xrgb1555_to_rgb24`
- `xrgb1555_to_rgb24_strided`

**Step 1: Convert runner.rs to directory module**

```bash
cd /root/projects/games-vault
mv libretro-runner/src/runner.rs libretro-runner/src/runner/mod.rs
```

**Step 2: Create pixels.rs with extracted functions**

All functions are `fn` (not methods on Core), so pure extraction — no visibility changes needed. Add `pub(super)` if called from mod.rs.

**Step 3: Add `mod pixels;` to mod.rs**

Add after existing `use` statements.

**Step 4: Verify**

```bash
cargo check -p libretro-runner
cargo test -p libretro-runner
```

Expected: exit 0, all tests pass.

**Step 5: Commit**

```bash
git add libretro-runner/src/runner/
git commit -m "refactor: extract pixel conversion to runner/pixels.rs"
```

---

### Task 6: Split gv-worker/src/main_body/mod.rs into focused modules

**Objective:** 1233-line god file → 4 focused modules: `handlers`, `webrtc`, `streaming`, `input`.

**Current structure:**
| Lines | Concern | → Module |
|-------|---------|----------|
| 68–189 | SdpOffer, PeerLifecycle, PeerState, broadcast_room_state, build_app | `mod.rs` (keep) |
| 257–508 | SDP parsing, encoders, WebRTC stack build, SDP exchange, DC handler | `webrtc.rs` |
| 889–1093 | StreamCtx, probe/rebuild encoder, push video/audio frame, fan_out, send_stats | `streaming.rs` |
| 1095–1220 | stream_frames main loop | `streaming.rs` |
| 1221–1233 | map_key_to_joypad | `input.rs` |
| 303–344 | CoreHandle, load_core | `webrtc.rs` or `core.rs` |

**Files:**
- Create: `gv-worker/src/main_body/webrtc.rs`
- Create: `gv-worker/src/main_body/streaming.rs`
- Create: `gv-worker/src/main_body/input.rs`
- Modify: `gv-worker/src/main_body/mod.rs`

**Step 1: Convert to directory module**

```bash
mv gv-worker/src/main_body/mod.rs gv-worker/src/main_body/mod.rs.bak
mkdir -p gv-worker/src/main_body
mv gv-worker/src/main_body/mod.rs.bak gv-worker/src/main_body/mod.rs
```

**Step 2: Extract webrtc.rs**

Move: `sdp_offer_supports_h264`, `create_video_encoder`, `CoreHandle`, `load_core`, `EncoderSet`, `setup_encoders`, `reuse_encoders`, `WebRtcStack`, `build_webrtc_stack`, `exchange_sdp`, `spawn_dc_handler`.
Add `pub(super)` to items called from mod.rs.

**Step 3: Extract streaming.rs**

Move: `StreamCtx`, `probe_and_rebuild_encoder`, `push_video_frame`, `push_audio`, `fan_out_video`, `fan_out_audio`, `send_stats`, `stream_frames`.
Add `pub(super)`.

**Step 4: Extract input.rs**

Move: `map_key_to_joypad`.

**Step 5: Add mod declarations to mod.rs**

```rust
mod webrtc;
mod streaming;
mod input;
```

**Step 6: Verify**

```bash
cargo check -p gv-worker
```

Expected: exit 0.

**Step 7: Commit**

```bash
git add gv-worker/src/main_body/
git commit -m "refactor: split gv-worker main_body into webrtc/streaming/input modules"
```

---

### Task 7: Split gv-server/src/worker.rs into focused modules

**Objective:** 945-line file → modules by concern: `core`, `pid`, `spawn`.

**Current structure:**
| Lines | Concern | → Module |
|-------|---------|----------|
| 30–112 | resolve_core_path, ensure_core, download_and_extract | `core.rs` |
| 208–340 | worker_host, pid_path, write_pid_file, reap_stale_workers | `pid.rs` |
| 343–480 | generate_worker_control_token | `spawn.rs` |
| 480–524 | default_worker_bin, resolve_worker_bin | `spawn.rs` |
| 525–945 | spawn_worker (large function) | `spawn.rs` |
| 190–206 | ensure_core_for_test | `core.rs` |

**Files:**
- Create: `gv-server/src/worker/core.rs`
- Create: `gv-server/src/worker/pid.rs`
- Create: `gv-server/src/worker/spawn.rs`
- Modify: `gv-server/src/worker/mod.rs`

**Step 1: Convert to directory module**

```bash
mv gv-server/src/worker.rs gv-server/src/worker/mod.rs
```

**Step 2: Extract submodules**

Same pattern as Task 6. Use `pub(super)` for cross-module visibility.

**Step 3: Verify**

```bash
cargo check -p gv-server
cargo test -p gv-server
```

Expected: exit 0, all tests pass.

**Step 4: Commit**

```bash
git add gv-server/src/worker/
git commit -m "refactor: split gv-server worker into core/pid/spawn modules"
```

---

### Task 8: Split gv-server/src/commands.rs

**Objective:** After dead code removal (Task 2), the file is ~300 lines of utility functions. Split by concern.

**Remaining functions after Task 2:**
| Function | Concern | → Module |
|----------|---------|----------|
| `release_manifest_path`, `load_release_manifest`, `normalize_binary_path` | binary paths | keep in mod.rs or `version.rs` |
| `component_version`, `collect_component_versions`, `collect_metadata` | metadata/version collection | `version.rs` |

**Files:**
- Create: `gv-server/src/commands/version.rs`
- Modify: `gv-server/src/commands/mod.rs`

**Step 1: Convert to directory module**

```bash
mv gv-server/src/commands.rs gv-server/src/commands/mod.rs
```

**Step 2: Extract version.rs**

Move `component_version`, `collect_component_versions`, `collect_metadata`. Add `pub(super)`.

**Step 3: Verify**

```bash
cargo check -p gv-server
```

Expected: exit 0.

**Step 4: Commit**

```bash
git add gv-server/src/commands/
git commit -m "refactor: split commands.rs — extract version metadata to submodule"
```

---

## Phase 3: Hygiene

### Task 9: Replace unwrap() with expect() in production code

**Objective:** 29 unwraps across the codebase. Replace each with `.expect("why this can't fail")` or proper error propagation.

**Production unwraps (non-test, non-FFI):**

| File | Line | Context | Fix |
|------|------|---------|-----|
| `gv-server/src/scan.rs:13` | — | (check if in `#[cfg(test)]` — most scan.rs unwraps are test code) | — |
| `gv-server/src/dat.rs:6` | — | (check — likely tests) | — |
| `gv-server/src/worker.rs:650,665` | `lines_seen.lock().unwrap()` | Mutex lock in spawn_worker | `.expect("lines_seen mutex poisoned")` |
| `gv-server/src/retry.rs:42` | `Err(last_err.unwrap())` | unwrap on Option after checking is_some | Use `last_err.expect("checked is_some")` or restructure |
| `gv-worker/src/main_body/mod.rs:1` | — | locate and fix | `.expect(...)` |
| `gv-worker/src/main_body/handlers.rs:1` | — | locate and fix | `.expect(...)` |
| `gv-worker/src/player_assets.rs:2` | — | locate and fix | `.expect(...)` |
| `libretro-runner/src/info.rs:1` | — | locate and fix | `.expect(...)` |

**Step 1: Locate each unwrap with context**

```bash
rg -n '\.unwrap\(\)' --type rust -g '!target' -g '!*test*' gv-server/src/ gv-worker/src/ libretro-runner/src/
```

For each hit, read 2 lines of context to understand why it's called.

**Step 2: Replace each**

- Mutex/poisoning: `.expect("mutex poisoned")`
- I/O operations in startup: `.expect("failed to <operation>: <reason>")`
- Parse operations: `.expect("invalid <format>: <context>")`
- If genuinely fallible → propagate with `?` instead

**Step 3: Verify**

```bash
cargo check --workspace
cargo clippy --workspace
```

Expected: exit 0, zero new warnings. Clippy may flag `expect()` usage but that's a style preference — ignore.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: replace unwrap() with expect() in production code"
```

---

### Task 10: Fix remaining clippy warnings (non-auto-fixable)

**Objective:** Address the 7 remaining clippy warnings after Task 1.

| Warning | File | Fix |
|---------|------|-----|
| `needless_range_loop` | `gv-server/src/dat.rs:327` | Use iterator with enumerate |
| `doc_lazy_continuation` | `libretro-runner/src/lib.rs:97` | Indent doc comment line |
| `dead_code` (cmd_pair etc.) | `gv-server/src/commands.rs` | Already deleted in Task 2 |
| `unused_import` | `gv-server/src/commands.rs:12` | Already deleted in Task 2 |
| `private_interfaces` | `gv-worker/src/main_body/mod.rs:163` | Make `PeerState` `pub(super)` |
| `dead_code` (Authenticating) | `gv-worker/src/main_body/mod.rs:103` | Already deleted in Task 3 |

**Step 1: Fix needless_range_loop**

In `gv-server/src/dat.rs:327`, rewrite the `for i in (open_pos+1)..bytes.len()` to use `bytes.iter().enumerate().skip(open_pos+1)`.

**Step 2: Fix doc_lazy_continuation**

In `libretro-runner/src/lib.rs:97`, indent the doc line by 4 spaces.

**Step 3: Fix private_interfaces**

Change `struct PeerState` to `pub(super) struct PeerState` in `gv-worker/src/main_body/mod.rs`.

**Step 4: Verify zero warnings**

```bash
cargo clippy --workspace 2>&1 | grep -c 'warning:'
```

Expected: 0 (or only warnings from dependencies we can't control).

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: fix remaining clippy warnings (dat.rs loop, doc indent, PeerState visibility)"
```

---

### Task 11: Split gv-web god components (TypeScript)

**Objective:** 5 TSX files >400 lines. Extract sub-components and hooks where practical.

**God files:**
| File | Lines | Split strategy |
|------|-------|----------------|
| `app/dashboard/page.tsx` | 794 | Extract sections into `dashboard/` components |
| `app/dashboard/DashboardClient.tsx` | 711 | Extract data fetching hooks, split panels |
| `app/dashboard/ServerPanel.tsx` | 639 | Extract form sections, validation logic |
| `components/GamePlayer.tsx` | 615 | Already partially split (has .module.css, RemapPanel). Extract input handling hook |
| `components/LibraryClient.tsx` | 499 | Extract filter/sort logic, row component |

**Step 1: Inspect each file's structure**

```bash
cd /root/projects/games-vault/gv-web
# For each god file, grep component/function declarations
grep -n 'export.*function\|export.*const.*=.*(\|function \|const.*=.*(' app/dashboard/page.tsx
```

**Step 2: Split GamePlayer.tsx first (highest impact)**

This file already has `GamePlayer.module.css` and `GamePlayerRemapPanel.tsx` extracted. Look for:
- Input/keyboard handling → `useGameInput` hook
- WebRTC connection setup → `useWebRTC` hook  
- Game state management → `useGameState` hook

**Step 3: Split DashboardClient.tsx**

Extract into:
- `app/dashboard/DashboardStats.tsx` — stat cards/gauges
- `app/dashboard/ServerList.tsx` — server listing
- `app/dashboard/useDashboardData.ts` — data fetching hook

**Step 4: Split ServerPanel.tsx**

Extract into:
- `app/dashboard/ServerForm.tsx` — form fields
- `app/dashboard/useServerForm.ts` — validation + submit logic

**Step 5: Split page.tsx and LibraryClient.tsx**

Same pattern — extract presentation from logic.

**Step 6: Verify**

```bash
cd /root/projects/games-vault/gv-web
npx tsc --noEmit
npm run build 2>&1 | tail -5
```

Expected: zero tsc errors, build succeeds.

**Step 7: Commit**

```bash
git add gv-web/
git commit -m "refactor: split gv-web god components into focused modules"
```

---

### Task 12: Final verification sweep

**Objective:** Confirm everything compiles, clippy is clean, tests pass.

**Step 1: Full workspace build**

```bash
cd /root/projects/games-vault
cargo build --workspace
```

**Step 2: Full test run**

```bash
cargo test --workspace
```

**Step 3: Clippy zero**

```bash
cargo clippy --workspace 2>&1 | grep -c 'warning:'
```

Expected: 0.

**Step 4: gv-web build**

```bash
cd gv-web && npm run build
```

Expected: success.

**Step 5: LOC change report**

```bash
pygount --format=summary --folders-to-skip=".git,node_modules,target" .
```

Compare to baseline: Rust LOC should have decreased (dead code removed). File count should have increased (god files split).

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: final verification — all checks pass after cleanup"
```

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Module extraction breaks `pub` visibility | Use `pub(super)` as minimum; `cargo check` after each extraction |
| Removing dead_code attr exposes real dead code | Task 4 audits each suppression before removal |
| TS component splits break imports | `npx tsc --noEmit` after every split |
| unwrap → expect changes behavior | All unwraps in startup/I/O paths where failure should crash anyway |

## Attack Order

1. **Task 1–4** (Phase 1, ~30 min): Mechanical, zero risk, biggest line-count reduction.
2. **Task 5–8** (Phase 2, ~45 min): Structural refactors, each self-contained.
3. **Task 9–11** (Phase 3, ~30 min): Hygiene, one task per category.
4. **Task 12** (5 min): Final sweep.
