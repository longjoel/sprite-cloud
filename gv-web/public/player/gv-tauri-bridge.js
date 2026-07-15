// ── gv-tauri-bridge — native gamepad → Web Gamepad API bridge ──────────
//
// When running inside a Tauri webview, replaces navigator.getGamepads with
// a function that returns gamepad state polled from gilrs via Tauri events.
// When running in a plain browser, silently no-ops.
//
// Tauri backend emits "gamepad-state" events:
//   { ports: [{ mask: u16, connected: bool }, ...] }
//
// Mask bit layout (RetroPad):
//   bit 0: South (B)      bit  6: DPad Left
//   bit 1: East           bit  7: DPad Right
//   bit 2: Select         bit  8: North (X)
//   bit 3: Start          bit  9: West (Y)
//   bit 4: DPad Up        bit 10: Left Trigger (L)
//   bit 5: DPad Down      bit 11: Right Trigger (R)

(function () {
  "use strict";

  // ── Guard: only activate within Tauri ───────────────────────────────
  if (typeof window === "undefined" || !window.__TAURI__) {
    return;
  }

  // ── Internal state ───────────────────────────────────────────────────
  var NUM_PORTS = 4;

  /** @type {Array<{mask: number, connected: boolean}>} */
  var ports = [];
  for (var i = 0; i < NUM_PORTS; i++) {
    ports.push({ mask: 0, connected: false });
  }

  var lastTimestamp = 0;

  // ── Mask → button lookup ────────────────────────────────────────────
  /**
   * Map a RetroPad mask bit to a standard Gamepad button index.
   * Returns -1 if the bit is not mapped.
   */
  var MASK_TO_BUTTON = [];
  MASK_TO_BUTTON[0]  = 0;   // South/B     → button 0
  MASK_TO_BUTTON[1]  = 1;   // East        → button 1
  MASK_TO_BUTTON[2]  = 8;   // Select      → button 8
  MASK_TO_BUTTON[3]  = 9;   // Start       → button 9
  MASK_TO_BUTTON[4]  = 12;  // DPad Up     → button 12
  MASK_TO_BUTTON[5]  = 13;  // DPad Down   → button 13
  MASK_TO_BUTTON[6]  = 14;  // DPad Left   → button 14
  MASK_TO_BUTTON[7]  = 15;  // DPad Right  → button 15
  MASK_TO_BUTTON[8]  = 3;   // North/X     → button 3
  MASK_TO_BUTTON[9]  = 2;   // West/Y      → button 2
  MASK_TO_BUTTON[10] = 4;   // L           → button 4
  MASK_TO_BUTTON[11] = 5;   // R           → button 5

  var TOTAL_BUTTONS = 17; // standard Gamepad: 16 buttons + 1 padding

  /**
   * Build a standard GamepadButton object from a pressed flag.
   * @param {boolean} pressed
   * @returns {{pressed: boolean, touched: boolean, value: number}}
   */
  function makeButton(pressed) {
    return {
      pressed: pressed,
      touched: pressed,
      value: pressed ? 1.0 : 0.0,
    };
  }

  /**
   * Build a Gamepad-compatible object from a port index and mask.
   * @param {number} index
   * @param {{mask: number, connected: boolean}} port
   * @returns {{axes: number[], buttons: Array<{pressed:boolean,touched:boolean,value:number}>, connected: boolean, id: string, index: number, mapping: string, timestamp: number}}
   */
  function buildGamepad(index, port) {
    var buttons = [];
    for (var b = 0; b < TOTAL_BUTTONS; b++) {
      buttons[b] = makeButton(false);
    }

    if (port.connected) {
      for (var bit = 0; bit < 12; bit++) {
        if (port.mask & (1 << bit)) {
          var btnIdx = MASK_TO_BUTTON[bit];
          if (btnIdx >= 0) {
            buttons[btnIdx] = makeButton(true);
          }
        }
      }
    }

    return {
      axes: [0, 0, 0, 0],
      buttons: buttons,
      connected: port.connected,
      id: "Native Gamepad (Port " + (index + 1) + ")",
      index: index,
      mapping: "standard",
      timestamp: lastTimestamp,
      vibrationActuator: null,
    };
  }

  // ── Listen for native gamepad state events ──────────────────────────
  window.__TAURI__.event.listen("gamepad-state", function (event) {
    var payload = event.payload;
    if (payload && payload.ports) {
      ports = payload.ports;
      lastTimestamp = performance.now();
    }
  });

  // ── Replace navigator.getGamepads ───────────────────────────────────
  var originalGetGamepads = navigator.getGamepads;

  /**
   * Replacement for navigator.getGamepads that returns native gamepad
   * state when running in Tauri; falls back to browser gamepads otherwise.
   * @returns {Array}
   */
  navigator.getGamepads = function () {
    var result = [];
    for (var i = 0; i < NUM_PORTS; i++) {
      result[i] = buildGamepad(i, ports[i]);
    }
    return result;
  };

  console.log("[TAURI] Gamepad bridge active");

  // ── Auth session persistence ──────────────────────────────────────
  // Persist the next-auth session token in Tauri's secure store so the
  // user stays signed in across app restarts (replaces browser cookie jar).

  var STORE_PATH = "session.json";
  var AUTH_KEY = "authToken";
  var COOKIE_NAME = "next-auth.session-token";
  var POLL_MS = 5000; // periodic cookie watch interval

  /** Read the stored token and restore the session cookie. */
  function restoreSession() {
    try {
      window.__TAURI__.core
        .invoke("plugin:store|get", { path: STORE_PATH, key: AUTH_KEY })
        .then(function (token) {
          if (token && typeof token === "string" && token.length > 0) {
            document.cookie =
              COOKIE_NAME +
              "=" +
              token +
              "; Secure; SameSite=Lax; path=/";
            console.log("[TAURI] Session restored from secure store");
          }
        })
        .catch(function () {
          // Store not initialised or key not found — expected on first run
        });
    } catch (_) {
      // Plugin not available or invoke failed — silently skip
    }
  }

  /** Extract the next-auth session token from cookies and persist it. */
  function persistSession() {
    try {
      var cookies = document.cookie;
      var match = cookies.match(
        new RegExp(COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]+)")
      );
      if (match && match[1]) {
        var token = match[1];
        window.__TAURI__.core
          .invoke("plugin:store|set", {
            path: STORE_PATH,
            key: AUTH_KEY,
            value: token,
          })
          .then(function () {
            return window.__TAURI__.core.invoke("plugin:store|save", {
              path: STORE_PATH,
            });
          })
          .catch(function () {
            // Store write failed — non-critical
          });
      }
    } catch (_) {
      // Plugin not available — silently skip
    }
  }

  // Restore saved session on startup (runs after a short delay to let
  // Tauri finish initialising the plugin commands).
  setTimeout(restoreSession, 200);

  // Periodically watch for new sign-ins and persist the token.
  setInterval(persistSession, POLL_MS);
})();
