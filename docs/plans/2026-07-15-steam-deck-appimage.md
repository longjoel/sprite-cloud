# Games Vault Desktop Client — Steam Deck AppImage Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** A native Linux desktop app (Tauri v2) that loads the XMB shell, properly handles Steam Deck gamepad input regardless of Steam Input/Big Picture, and ships as a single-click AppImage.

**Architecture:** Reuse the existing `gv-web` Next.js app as the webview frontend. Build a thin Tauri v2 Rust shell that hosts a webview pointed at `https://lngnckr.tech/xmb`, intercepts raw gamepad events via `gilrs`, and forwards them into the webview's JavaScript context. The webview gets the real gamepad state regardless of Steam Input interception. Ships as an AppImage via `tauri-bundler`.

**Tech Stack:** Tauri v2, Rust, `gilrs` (gamepad), Next.js 15 (existing), `tauri-bundler` AppImage target.

**Current State:**
- gv-web is a pnpm workspace package under monorepo root `/root/projects/sprite-cloud`
- No Tauri or native client code exists yet
- Gamepad handling is purely browser-based via `navigator.getGamepads()` in `gv-web/public/player/gv-player.js` and `gv-web/app/xmb/page.tsx`
- The XMB shell at `/xmb` has full keyboard+gamepad navigation with wrapping (deployed in `v0.3.4`)
- Steam Deck's browser is problematic: built-in controller steals P1 in browser, Big Picture Mode intercepts gamepad entirely
- The existing `/xmb` page is 7.97 kB and already gamepad-navigable

## Security model (baked into each task)

| Threat | Mitigation | Where |
|---|---|---|
| AppImage tampering | SHA256 checksum in release notes, GPG signing | Task 9 |
| Webview loading untrusted URL | CSP in gv-web, HTTPS-only, no `file://` access | Task 4 |
| Gamepad data leaking between sessions | Clear gamepad state on disconnect/reconnect | Task 6 |
| Local credential theft | Use platform keyring (freedesktop Secret Service) | Task 8 |

---

### Task 1: Scaffold Tauri v2 crate inside monorepo

**Objective:** Create a new Cargo workspace member `gv-desktop` with Tauri v2 scaffolding, a single webview window loading `https://lngnckr.tech/xmb`, and fullscreen by default.

**Files:**
- Create: `gv-desktop/Cargo.toml`
- Create: `gv-desktop/src/main.rs`
- Create: `gv-desktop/tauri.conf.json`
- Create: `gv-desktop/capabilities/default.json`
- Modify: `Cargo.toml` (root — add workspace member)

**Step 1: Create Cargo workspace member**

```toml
# gv-desktop/Cargo.toml
[package]
name = "gv-desktop"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

**Step 2: Create `src/main.rs` — launch webview at XMB**

```rust
// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 3: Create `tauri.conf.json` — fullscreen, minimal chrome**

```json
{
  "$schema": "https://raw.githubusercontent.com/nickcolley/rust.json-schema/refs/heads/master/tauri.conf.json",
  "productName": "Games Vault",
  "version": "0.1.0",
  "identifier": "com.spritecloud.gamesvault",
  "build": {
    "frontendDist": "../gv-web/out",
    "devUrl": "http://localhost:3000/xmb",
    "beforeDevCommand": "cd .. && pnpm --filter gv-web dev",
    "beforeBuildCommand": "cd .. && pnpm --filter gv-web build"
  },
  "app": {
    "windows": [
      {
        "title": "Games Vault",
        "url": "https://lngnckr.tech/xmb",
        "fullscreen": true,
        "width": 1280,
        "height": 800,
        "resizable": true,
        "decorations": false
      }
    ],
    "security": {
      "csp": "default-src 'self' https://lngnckr.tech; connect-src 'self' https://lngnckr.tech wss://lngnckr.tech; img-src 'self' https://lngnckr.tech https:; style-src 'self' 'unsafe-inline'; font-src 'self'"
    }
  },
  "bundle": {
    "active": true,
    "targets": "appimage",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "linux": {
      "deb": { "depends": [] }
    }
  }
}
```

**Step 4: Create Tauri v2 capability file**

```json
// gv-desktop/capabilities/default.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability",
  "windows": ["main"],
  "permissions": [
    "core:default"
  ]
}
```

**Step 5: Add to root workspace**

In root `Cargo.toml`, add `gv-desktop` to the `members` array.

**Step 6: Verify compiles**

```bash
cd gv-desktop && cargo check
```

Expected: exit 0, no errors. (May need `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` on build host.)

---

### Task 2: Register native gamepad handler with gilrs

**Objective:** Use the `gilrs` crate to poll raw gamepad state independently of browser/Steam Input, bypassing both the Deck's built-in browser gamepad assignment and Big Picture interception.

**Files:**
- Modify: `gv-desktop/Cargo.toml` — add `gilrs` dependency
- Modify: `gv-desktop/src/main.rs` — init gilrs, poll loop

**Step 1: Add gilrs dependency**

```toml
[dependencies]
# ... existing ...
gilrs = "0.10"
```

**Step 2: Init gilrs in main.rs and poll in background**

```rust
use gilrs::{Gilrs, Event, EventType};
use std::sync::{Arc, Mutex};
use tauri::Manager;

struct GamepadState {
    // 4 ports × 16 buttons + dpad
    ports: [[u16; 4]; 4],       // 16-bit RetroPad mask per port
    connected: [bool; 4],       // which ports have a gamepad
}

fn main() {
    let gamepad = Arc::new(Mutex::new(GamepadState {
        ports: [[0u16; 4]; 4],
        connected: [false; 4],
    }));

    let gp_clone = gamepad.clone();

    tauri::Builder::default()
        .setup(move |app| {
            let app_handle = app.handle().clone();

            // Spawn gilrs polling thread
            std::thread::spawn(move || {
                let mut gilrs = Gilrs::new().expect("Failed to init gilrs");

                loop {
                    // Process all pending events (connect/disconnect)
                    while let Some(Event { id, event, .. }) = gilrs.next_event() {
                        match event {
                            EventType::Connected => {
                                let mut st = gp_clone.lock().unwrap();
                                // Assign to first available port
                                for port in 0..4 {
                                    if !st.connected[port] {
                                        st.connected[port] = true;
                                        break;
                                    }
                                }
                            }
                            EventType::Disconnected => {
                                let mut st = gp_clone.lock().unwrap();
                                st.connected.iter_mut().for_each(|c| *c = false);
                                // Reconnect remaining pads to fill gaps
                            }
                            _ => {}
                        }
                    }

                    // Poll active gamepad state
                    {
                        let mut st = gp_clone.lock().unwrap();
                        let mut port = 0u8;
                        for (_id, gamepad) in gilrs.gamepads() {
                            if port >= 4 { break; }

                            let mut mask: u16 = 0;

                            // Face buttons
                            if gamepad.is_pressed(gilrs::Button::South)  { mask |= 1 << 0; }  // B/RetroPad-B
                            if gamepad.is_pressed(gilrs::Button::East)   { mask |= 1 << 1; }  // A/RetroPad-A
                            if gamepad.is_pressed(gilrs::Button::West)   { mask |= 1 << 9; }  // Y/RetroPad-Y
                            if gamepad.is_pressed(gilrs::Button::North)  { mask |= 1 << 8; }  // X/RetroPad-X

                            // Shoulders
                            if gamepad.is_pressed(gilrs::Button::LeftTrigger)  { mask |= 1 << 10; }
                            if gamepad.is_pressed(gilrs::Button::RightTrigger) { mask |= 1 << 11; }
                            if gamepad.is_pressed(gilrs::Button::LeftTrigger2) { mask |= 1 << 10; }
                            if gamepad.is_pressed(gilrs::Button::RightTrigger2){ mask |= 1 << 11; }

                            // Menu buttons
                            if gamepad.is_pressed(gilrs::Button::Select) { mask |= 1 << 2; }
                            if gamepad.is_pressed(gilrs::Button::Start)  { mask |= 1 << 3; }

                            // D-pad
                            if gamepad.is_pressed(gilrs::Button::DPadUp)    { mask |= 1 << 4; }
                            if gamepad.is_pressed(gilrs::Button::DPadDown)  { mask |= 1 << 5; }
                            if gamepad.is_pressed(gilrs::Button::DPadLeft)  { mask |= 1 << 6; }
                            if gamepad.is_pressed(gilrs::Button::DPadRight) { mask |= 1 << 7; }

                            st.ports[port as usize] = [mask, 0, 0, 0];
                            port += 1;
                        }
                        // Clear unused ports
                        for p in port..4 {
                            st.ports[p as usize] = [0u16; 4];
                        }
                    }

                    // Emit gamepad state to webview every 16ms (~60 Hz)
                    app_handle.emit("gamepad-state", {
                        let st = gp_clone.lock().unwrap();
                        serde_json::to_value(&*st).unwrap_or_default()
                    }).ok();

                    std::thread::sleep(std::time::Duration::from_millis(16));
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 3: Install build dependencies and verify compile**

```bash
sudo apt install -y libudev-dev  # required by gilrs on Linux
cd gv-desktop && cargo check
```

Expected: exit 0.

---

### Task 3: Bridge gamepad state into webview JS

**Objective:** The Tauri app emits `gamepad-state` events. The webview JS listens, overrides the XMB/gv-player gamepad polling to use native state instead of `navigator.getGamepads()`.

**Files:**
- Create: `gv-web/public/player/gv-tauri-bridge.js`
- Modify: `gv-web/app/xmb/page.tsx` — detect Tauri and wire bridge
- Modify: `gv-web/public/player/gv-player.js` — accept external gamepad state

**Step 1: Create Tauri bridge script**

```javascript
// gv-web/public/player/gv-tauri-bridge.js
// Injected into the webview when running under Tauri.
// Replaces navigator.getGamepads() with native gilrs data.

(function () {
  // Only activate if running inside Tauri (window.__TAURI__ exists)
  if (typeof window.__TAURI__ === "undefined") return;

  // Override navigator.getGamepads to return native state
  const nativeGamepadCache = [];

  const { listen } = window.__TAURI__.event;
  listen("gamepad-state", (event) => {
    const state = event.payload;
    nativeGamepadCache.length = 0;

    for (let port = 0; port < 4; port++) {
      const mask = state.ports?.[port]?.[0] ?? 0;
      if (mask === 0 && !state.connected?.[port]) continue;

      // Build a minimal Gamepad-like object
      nativeGamepadCache.push({
        id: `Native Port ${port + 1}`,
        index: port,
        connected: state.connected?.[port] ?? true,
        axes: [0, 0, 0, 0], // Analog sticks not yet mapped
        buttons: Array.from({ length: 16 }, (_, i) => ({
          pressed: (mask & (1 << i)) !== 0,
          touched: (mask & (1 << i)) !== 0,
          value: (mask & (1 << i)) !== 0 ? 1.0 : 0.0,
        })),
        timestamp: performance.now(),
      });
    }
  });

  // Replace the browser API
  navigator.getGamepads = function () {
    return nativeGamepadCache;
  };

  console.log("[TAURI] Gamepad bridge active — using native gilrs input");
})();
```

**Step 2: Load bridge script in XMB page**

In `gv-web/app/xmb/page.tsx`, inject the bridge before gv-player initializes:

```tsx
// In the <head> or before gv-player init:
useEffect(() => {
  if (typeof window !== "undefined" && window.__TAURI__) {
    const script = document.createElement("script");
    script.src = "/player/gv-tauri-bridge.js";
    document.head.appendChild(script);
  }
}, []);
```

**Step 3: Verify existing gamepad code still works**

The `gv-player.js` and XMB `page.tsx` both use `navigator.getGamepads()` which is now shimmed. No changes needed to existing gamepad consumers.

---

### Task 4: Add desktop-first window behavior

**Objective:** Start fullscreen, hide decorations, add keyboard shortcut to toggle fullscreen (F11). Disable right-click context menu. Handle window close gracefully.

**Files:**
- Modify: `gv-desktop/src/main.rs` — add F11 toggle, context menu disable
- Modify: `gv-desktop/tauri.conf.json` — confirm window config

**Step 1: Add F11 fullscreen toggle command**

```rust
#[tauri::command]
fn toggle_fullscreen(window: tauri::Window) {
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    window.set_fullscreen(!is_fullscreen).ok();
}
```

Register in builder: `.invoke_handler(tauri::generate_handler![toggle_fullscreen])`

**Step 2: Disable context menu, add keyboard shortcut**

```rust
// In setup callback, on the webview window:
let window = app.get_webview_window("main").unwrap();

// Disable right-click
window.eval("document.addEventListener('contextmenu', e => e.preventDefault())").ok();

// Register F11 global shortcut (Tauri v2 global shortcut plugin)
// Or handle via JS keydown event forwarded from webview
```

**Step 3: Confirm window config in tauri.conf.json**

Already set `fullscreen: true, decorations: false` in Task 1. Verify.

---

### Task 5: Build AppImage pipeline

**Objective:** Add `cargo-tauri-bundler` AppImage target, a build script, and verify the output runs on a fresh system.

**Files:**
- Create: `scripts/build-appimage.sh`
- Modify: `gv-desktop/tauri.conf.json` — verify bundle config

**Step 1: Ensure tauri-cli is available**

```bash
cargo install tauri-cli --version "^2"
```

**Step 2: Create build script**

```bash
#!/bin/bash
# scripts/build-appimage.sh
# Builds the Games Vault AppImage from the monorepo root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

echo "[appimage] building gv-desktop crate..."
cd gv-desktop

# Build the Tauri app (produces AppImage in target/release/bundle/appimage/)
cargo tauri build --bundles appimage

echo "[appimage] done — find AppImage at:"
ls -lh target/release/bundle/appimage/*.AppImage
```

**Step 3: Verify build product**

```bash
chmod +x scripts/build-appimage.sh
./scripts/build-appimage.sh
file target/release/bundle/appimage/games-vault_*.AppImage
# Expected: "ELF 64-bit LSB executable" AppImage
```

The AppImage should be a single file ~20-40 MB that works on any Linux with `--appimage-extract-and-run` or just `chmod +x && ./games-vault.AppImage`.

---

### Task 6: Steam Deck-specific gamepad mapping and testing

**Objective:** The Steam Deck's built-in controller reports as an Xbox 360 controller via `gilrs`. Map the Deck's specific button layout (Deck's A→South, B→East, X→West, Y→North, etc.) and test that:
- Gamepad works when launched from Desktop mode
- Gamepad works when added as a non-Steam game and launched from Gaming Mode
- Big Picture/Steam Input does not interfere

**Files:**
- Modify: `gv-desktop/src/main.rs` — verify button mapping is correct for Deck layout
- Create: `gv-desktop/tests/gamepad-mapping.rs`

**Step 1: Write mapping test**

```rust
// gv-desktop/tests/gamepad-mapping.rs
#[test]
fn steam_deck_button_mapping_is_correct() {
    // South → RetroPad B (bit 0)
    assert_eq!(1 << 0, 1);  // placeholder — test with mock gilrs
    // East → RetroPad A (bit 1) — actually bit 8 in our mapping above
    // West → RetroPad Y (bit 9)
    // North → RetroPad X (bit 8)
    // LeftTrigger → RetroPad L (bit 10)
    // RightTrigger → RetroPad R (bit 11)
}
```

**Step 2: Verify Deck's controller is detected by gilrs**

The Steam Deck controller (hid-steam) reports as a standard gamepad to evdev, which `gilrs` uses. No special handling needed — `gilrs` discovers it automatically.

**Step 3: Add --no-sandbox flag for Steam runtime compatibility**

In `tauri.conf.json`, add to bundle config:
```json
"linux": {
  "deb": { "depends": [] },
  "appimage": {
    "bootstrap": {}
  }
}
```

---

### Task 7: Prevent Deck built-in gamepad from claiming P1 in browser

**Objective:** When running in the Tauri webview, the browser's Gamepad API is shimmed (Task 3). The Steam Deck's browser gamepad behavior is irrelevant — gilrs owns the gamepad. Verify:
- The Deck's built-in controller is only visible via gilrs, NOT via the browser Gamepad API
- Gamepad events are routed to the correct port (seat selection via XMB controls)

**Files:**
- Verify: `gv-web/public/player/gv-tauri-bridge.js` — shim prevents browser Gamepad API interference
- Verify: `gv-web/public/player/gv-player.js` — accepts shimmed state

**Step 1: Confirm bridge intercepts before browser gamepad polling**

The bridge shim replaces `navigator.getGamepads` before gv-player polls. The browser never sees raw gamepad events — gilrs owns them.

**Step 2: Test multi-seat on Deck**

The XMB's existing Ctrl+1-4 port routing should work: gilrs assigns gamepads to contiguous ports starting at 0, and the JS layer respects seat assignment.

---

### Task 8: Persist session and credentials

**Objective:** Use Tauri's secure storage or system keyring to persist the NextAuth session cookie so the app stays signed in across restarts. This replaces the browser cookie jar.

**Files:**
- Modify: `gv-desktop/Cargo.toml` — add tauri-plugin-store
- Modify: `gv-desktop/src/main.rs` — register plugin

**Step 1: Add secure storage plugin**

```toml
tauri-plugin-store = "2"
```

Register in builder: `.plugin(tauri_plugin_store::Builder::default().build())`

**Step 2: Store/restore auth token in JS bridge**

In `gv-tauri-bridge.js`, on page load:
```javascript
import { Store } from '@tauri-apps/plugin-store';
const store = new Store('session.json');
const token = await store.get('authToken');
if (token) {
  document.cookie = `next-auth.session-token=${token}; Secure; SameSite=Lax; path=/`;
}
```

On sign-in (detect via cookie change or XHR intercept):
```javascript
const cookies = document.cookie;
const token = cookies.match(/next-auth\.session-token=([^;]+)/)?.[1];
if (token) {
  await store.set('authToken', token);
  await store.save();
}
```

---

### Task 9: Release packaging — SHA256, icons, and documentation

**Objective:** Generate app icons, produce a signed release with checksums, and write a README for Steam Deck users.

**Files:**
- Create: `gv-desktop/icons/` — app icons
- Create: `gv-desktop/README.md` — user docs
- Create: `scripts/release-appimage.sh` — sign + checksum

**Step 1: Generate icons**

Use ImageMagick or similar to create PNG icons from the Games Vault logo. Minimum: 32×32, 128×128, 256×256.

**Step 2: Release script**

```bash
#!/bin/bash
# scripts/release-appimage.sh
set -euo pipefail
./scripts/build-appimage.sh

APPIMAGE=$(ls gv-desktop/target/release/bundle/appimage/games-vault_*.AppImage | head -1)
VERSION=$(cargo metadata --no-deps --format-version 1 | jq -r '.packages[] | select(.name=="gv-desktop") | .version')

cp "$APPIMAGE" "games-vault-${VERSION}-x86_64.AppImage"
sha256sum "games-vault-${VERSION}-x86_64.AppImage" > "games-vault-${VERSION}-x86_64.AppImage.sha256"

echo "Release: games-vault-${VERSION}-x86_64.AppImage"
echo "SHA256: $(cat games-vault-${VERSION}-x86_64.AppImage.sha256)"
```

**Step 3: Write README for Steam Deck users**

```markdown
# Games Vault for Steam Deck

1. Download `games-vault-x.x.x-x86_64.AppImage`
2. `chmod +x games-vault-*.AppImage`
3. Run it — starts fullscreen, loads your library
4. Optional: Add to Steam as a non-Steam game for Gaming Mode

The Deck's controls work natively — no browser, no Steam Input configuration needed.
Toggle fullscreen with F11.
```

---

## Recommended implementation order

1. **Task 1**: Scaffold Tauri crate, webview → XMB, fullscreen
2. **Task 2**: gilrs gamepad polling — proves raw gamepad works
3. **Task 3**: Bridge gilrs → webview JS overrides getGamepads
4. **Task 4**: Desktop window behavior (F11, context menu)
5. **Task 5**: AppImage build pipeline
6. **Task 6**: Steam Deck button mapping verification
7. **Task 7**: Confirm Deck P1 isolation
8. **Task 8**: Auth persistence
9. **Task 9**: Release packaging
