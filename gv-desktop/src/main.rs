#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use gilrs::{Button, EventType, Gilrs};
use serde::Serialize;
use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

// ── Embedded fallback page ────────────────────────────────────────────────
// Served via the gv-loader:// custom protocol when the main app hasn't loaded yet.
const FALLBACK_HTML: &str = include_str!("index.html");

// ── Steam Deck / Mesa GPU compatibility ────────────────────────────────────
// webkit2gtk on Steam Deck (AMD GPU + Mesa) often fails with:
//   "Could not create default EGL display: EGL_BAD_PARAMETER"
// These env vars force a software-rendered compositing path that works
// reliably on Deck hardware. Set them before Tauri touches the GPU.
fn apply_steam_deck_gpu_quirks() {
    let vars = [
        ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
        ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
    ];
    for (key, value) in vars {
        if std::env::var(key).is_err() {
            std::env::set_var(key, value);
        }
    }
}

const NUM_PORTS: usize = 4;
const POLL_INTERVAL_MS: u64 = 16; // ~60 Hz

/// RetroPad-compatible button masks.
/// Bit mapping (from the plan):
///   South (B)      → bit 0
///   East           → bit 1
///   Select         → bit 2
///   Start          → bit 3
///   DPad Up        → bit 4
///   DPad Down      → bit 5
///   DPad Left      → bit 6
///   DPad Right     → bit 7
///   North (X)      → bit 8
///   West (Y)       → bit 9
///   LeftTrigger (L)→ bit 10
///   RightTrigger(R)→ bit 11
const MASK_SOUTH: u16 = 1 << 0;
const MASK_EAST: u16 = 1 << 1;
const MASK_SELECT: u16 = 1 << 2;
const MASK_START: u16 = 1 << 3;
const MASK_DPAD_UP: u16 = 1 << 4;
const MASK_DPAD_DOWN: u16 = 1 << 5;
const MASK_DPAD_LEFT: u16 = 1 << 6;
const MASK_DPAD_RIGHT: u16 = 1 << 7;
const MASK_NORTH: u16 = 1 << 8;
const MASK_WEST: u16 = 1 << 9;
const MASK_LEFT_TRIGGER: u16 = 1 << 10;
const MASK_RIGHT_TRIGGER: u16 = 1 << 11;

#[derive(Clone, Serialize)]
struct PortState {
    mask: u16,
    connected: bool,
}

impl Default for PortState {
    fn default() -> Self {
        PortState {
            mask: 0,
            connected: false,
        }
    }
}

#[derive(Clone, Serialize)]
struct GamepadState {
    ports: [PortState; 4],
}

impl Default for GamepadState {
    fn default() -> Self {
        GamepadState {
            ports: [
                PortState::default(),
                PortState::default(),
                PortState::default(),
                PortState::default(),
            ],
        }
    }
}

/// Map a gilrs Button to a RetroPad bit mask, if applicable.
/// Poll all relevant buttons from the gamepad state and build the mask.
fn poll_buttons(gp: &gilrs::Gamepad) -> u16 {
    let mut mask: u16 = 0;

    // Check each mapped button via Gamepad's is_pressed (takes gilrs::Button).
    if gp.is_pressed(Button::South) {
        mask |= MASK_SOUTH;
    }
    if gp.is_pressed(Button::East) {
        mask |= MASK_EAST;
    }
    if gp.is_pressed(Button::West) {
        mask |= MASK_WEST;
    }
    if gp.is_pressed(Button::North) {
        mask |= MASK_NORTH;
    }
    if gp.is_pressed(Button::LeftTrigger) {
        mask |= MASK_LEFT_TRIGGER;
    }
    if gp.is_pressed(Button::RightTrigger) {
        mask |= MASK_RIGHT_TRIGGER;
    }
    if gp.is_pressed(Button::Select) {
        mask |= MASK_SELECT;
    }
    if gp.is_pressed(Button::Start) {
        mask |= MASK_START;
    }
    if gp.is_pressed(Button::DPadUp) {
        mask |= MASK_DPAD_UP;
    }
    if gp.is_pressed(Button::DPadDown) {
        mask |= MASK_DPAD_DOWN;
    }
    if gp.is_pressed(Button::DPadLeft) {
        mask |= MASK_DPAD_LEFT;
    }
    if gp.is_pressed(Button::DPadRight) {
        mask |= MASK_DPAD_RIGHT;
    }

    mask
}

/// Poll the active gamepad state from gilrs and emit to the webview.
fn spawn_gamepad_poller(app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        let mut gilrs = match Gilrs::new() {
            Ok(g) => {
                eprintln!("[gilrs] Gamepad subsystem initialized");
                g
            }
            Err(e) => {
                eprintln!("[gilrs] Failed to initialize: {}", e);
                return;
            }
        };

        // Track which gilrs gamepad id maps to which port (0-3).
        // port_mapping[port] = Option<gilrs::GamepadId>
        let port_mapping: Arc<Mutex<[Option<gilrs::GamepadId>; NUM_PORTS]>> =
            Arc::new(Mutex::new([None; NUM_PORTS]));

        loop {
            // Process all pending events (connect, disconnect, button changes).
            while let Some(event) = gilrs.next_event() {
                let mut ports = port_mapping.lock().unwrap();

                match event.event {
                    EventType::Connected => {
                        eprintln!("[gilrs] Gamepad connected: {:?}", event.id);
                        // Assign to first free port.
                        if let Some(slot) = ports.iter_mut().find(|s| s.is_none()) {
                            *slot = Some(event.id);
                            eprintln!(
                                "[gilrs] Assigned gamepad {:?} to port {}",
                                event.id,
                                slot_index(&ports, Some(event.id))
                            );
                        } else {
                            eprintln!("[gilrs] No free port for gamepad {:?}", event.id);
                        }
                    }
                    EventType::Disconnected => {
                        eprintln!("[gilrs] Gamepad disconnected: {:?}", event.id);
                        if let Some(slot) = ports.iter_mut().find(|s| **s == Some(event.id)) {
                            *slot = None;
                            eprintln!("[gilrs] Freed port for gamepad {:?}", event.id);
                        }
                    }
                    _ => {} // Button changes are polled, not event-driven.
                }
            }

            // Poll the current state of all active gamepads.
            let mut state = GamepadState::default();
            {
                let ports = port_mapping.lock().unwrap();
                for (i, gp_id_opt) in ports.iter().enumerate() {
                    if let Some(gp_id) = gp_id_opt {
                        if let Some(gp) = gilrs.connected_gamepad(*gp_id) {
                            state.ports[i].connected = true;
                            state.ports[i].mask = 0;

                            // Poll pressed buttons.
                            state.ports[i].mask = poll_buttons(&gp);
                        } else {
                            // Stale mapping — gamepad disconnected without event.
                            state.ports[i].connected = false;
                            state.ports[i].mask = 0;
                        }
                    } else {
                        // Clear unused ports.
                        state.ports[i].connected = false;
                        state.ports[i].mask = 0;
                    }
                }
            }

            // Emit to the webview.
            if let Err(e) = app_handle.emit("gamepad-state", &state) {
                eprintln!("[gilrs] Failed to emit gamepad-state event: {}", e);
            }

            thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        }
    });
}

fn slot_index(
    ports: &[Option<gilrs::GamepadId>; NUM_PORTS],
    target: Option<gilrs::GamepadId>,
) -> usize {
    ports.iter().position(|s| *s == target).unwrap_or(usize::MAX)
}

/// Tauri command: toggle fullscreen on/off.
/// Bound to F11 via JavaScript in the webview.
#[tauri::command]
fn toggle_fullscreen(window: tauri::Window) {
    let current = window.is_fullscreen().unwrap_or(false);
    if let Err(e) = window.set_fullscreen(!current) {
        eprintln!("[fullscreen] Failed to toggle fullscreen: {}", e);
    }
}

fn main() {
    apply_steam_deck_gpu_quirks();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![toggle_fullscreen])
        // ── Custom protocol for the fallback loader page ─────────────────
        .register_uri_scheme_protocol("gv-loader", move |_ctx, _request| {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Access-Control-Allow-Origin", "*")
                .body(Cow::Owned(FALLBACK_HTML.as_bytes().to_vec()))
                .unwrap()
        })
        // ── App-level page load handler for logging ──────────────────────
        .on_page_load(|webview, payload| {
            let url = payload.url();
            eprintln!(
                "[page-load] webview={} url='{}'",
                webview.label(),
                url
            );
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // ── Create the main window programmatically (not auto-created) ─
            // This lets us add GPU browser args that aren't available via config.
            let window_config = &app.config().app.windows[0];

            #[allow(unused_mut)]
            let mut builder =
                tauri::WebviewWindowBuilder::from_config(&handle, window_config)
                    .expect("failed to create window builder from config");

            // ── GPU flags: disable GPU compositing in webkit2gtk ────────
            // These args help when webkit2gtk fails with EGL errors on
            // AMD GPUs (Steam Deck) or Intel integrated graphics.
            #[cfg(target_os = "linux")]
            {
                builder = builder.additional_browser_args(
                    "--disable-gpu --disable-software-rasterizer",
                );
                eprintln!("[gpu] Applied --disable-gpu --disable-software-rasterizer flags");
            }

            // ── Page load handler per-window ────────────────────────────
            builder = builder.on_page_load(|window, payload| {
                let url = payload.url();
                eprintln!(
                    "[page-load:{}] url='{}'",
                    window.label(),
                    url
                );

                // If we navigated to the real app (not the fallback),
                // inject the context-menu prevention script.
                let url_str = url.to_string();
                if url_str.starts_with("https://lngnckr.tech") {
                    let _ = window.eval(
                        "document.addEventListener('contextmenu', (e) => e.preventDefault());",
                    );
                    eprintln!("[page-load:{}] Injected context-menu prevention for app URL", window.label());
                }
            });

            let window = builder.build()?;

            // ── Devtools: open in debug builds or when app_debug is set ─
            open_devtools_if_enabled(&window);

            // ── Gamepad poller ──────────────────────────────────────────
            spawn_gamepad_poller(handle);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Open devtools when debug assertions are enabled OR the `app_debug` feature is active.
/// This enables devtools in both debug and release builds when the feature flag is set.
fn open_devtools_if_enabled(window: &tauri::WebviewWindow) {
    #[cfg(any(debug_assertions, feature = "app_debug"))]
    {
        window.open_devtools();
        eprintln!("[devtools] Opened devtools for main window");
    }
    #[cfg(not(any(debug_assertions, feature = "app_debug")))]
    {
        let _ = window;
    }
}
