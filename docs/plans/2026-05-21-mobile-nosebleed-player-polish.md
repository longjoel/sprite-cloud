# Mobile Nosebleed Player Polish Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Polish the mobile server-side Nosebleed player so touch, audio, fullscreen, and Bluetooth/hardware gamepad UX feel intentional and reliable on phones.

**Architecture:** Keep the existing Nosebleed input protocol unchanged. Refactor the large inline player script in `Views/Games/PlayServer.cshtml` into small client-side modules under `wwwroot/js/nosebleed-player/`, then add progressive enhancement features around the current canvas, overlay controls, audio, and Gamepad API support.

**Tech Stack:** ASP.NET Core Razor, vanilla JavaScript, browser Pointer Events, Fullscreen API, Web Audio API, Gamepad API, `localStorage`, existing xUnit test suite for server-side code, render/grep checks for Razor output.

---

## Current State

- Main file: `Views/Games/PlayServer.cshtml`.
- The server-side player renders a `#server-player-shell` containing `#nosebleed-screen` and overlay controls.
- Touch controls are already system-aware:
  - Game Gear: D-pad, `1`, `2`, Start.
  - Generic fallback: D-pad, Y/X/B/A, Select/Start.
- Touch state, keyboard state, and the first browser gamepad from `navigator.getGamepads?.()[0]` are merged in `sendInput()` and sent over `/ws/input` as the existing Nosebleed input payload.
- Fullscreen currently uses the player shell, not only the canvas.
- Double-tap fullscreen ignores touch controls and overlay buttons.
- Audio has a lower-page `Enable audio` button and in-player `Sound` button.
- Overlay layout editing already exists as a first pass:
  - `Unlock layout` / `Save layout`
  - draggable control groups via `data-control-group`
  - saved positions in `localStorage` per `touchLayoutName`
- Gaps to polish:
  - Hardware gamepad support has no connection/disconnection UI and only blindly polls slot `0`.
  - The script is now large enough that further UI behavior will be hard to maintain inline.
  - There is no reset/default option for bad saved overlay layouts.
  - Fullscreen, wake/screen behavior, audio, and orientation status are not surfaced clearly enough on mobile.
  - We need browser/device-friendly status hints without obscuring the game.

## Acceptance Criteria

- Mobile player still works without JavaScript module bundling or external dependencies.
- Touch controls, keyboard, and browser gamepad input continue to send the same Nosebleed payload shape.
- Bluetooth/hardware gamepad status is visible and updates when controllers connect/disconnect.
- The selected hardware gamepad is the first connected, non-null pad with buttons/axes, not always index `0`.
- Users can reset a saved overlay layout back to default.
- In-player controls stay small and non-obscuring.
- Fullscreen and audio actions provide clear status messages.
- Game Gear layout keeps only D-pad, Start, `1`, and `2`.
- Generic layout keeps D-pad, Y/X/B/A, Select, and Start.
- Build and tests pass before deployment.
- Verification avoids leaving orphaned Nosebleed sessions.

---

### Task 1: Extract player JavaScript into a dedicated static file

**Objective:** Move the large inline script out of `PlayServer.cshtml` so mobile UX improvements can be maintained safely.

**Files:**
- Create: `wwwroot/js/nosebleed-player/server-player.js`
- Modify: `Views/Games/PlayServer.cshtml`

**Step 1: Add a configuration JSON script block in the Razor view**

In `Views/Games/PlayServer.cshtml`, replace the top inline constants with a JSON script block before loading the static script:

```cshtml
<script type="application/json" id="nosebleed-player-config">
@Html.Raw(System.Text.Json.JsonSerializer.Serialize(new
{
    baseUrl = Model.BaseUrl,
    token = Model.Token,
    assignedPort = Model.AssignedPort,
    isSpectator = Model.IsSpectator,
    sessionId = Model.SessionId,
    touchLayoutName,
    keepAliveUrl = Url.Action("KeepAliveServerSession", "Games")
}))
</script>
<script src="~/js/nosebleed-player/server-player.js" asp-append-version="true"></script>
```

**Step 2: Move the existing script body**

Create `wwwroot/js/nosebleed-player/server-player.js` and wrap the existing JavaScript logic like this:

```js
(() => {
    const configEl = document.getElementById("nosebleed-player-config");
    if (!configEl) return;
    const config = JSON.parse(configEl.textContent || "{}");

    const baseUrl = config.baseUrl;
    const token = config.token;
    const assignedPort = config.assignedPort;
    const isSpectator = config.isSpectator;
    const sessionId = config.sessionId;
    const touchLayoutName = config.touchLayoutName;
    const keepAliveUrl = config.keepAliveUrl;

    // Move the existing implementation here unchanged first.
})();
```

**Step 3: Preserve behavior first**

Do not change player behavior in this task beyond the script extraction.

**Step 4: Run build/tests**

Run:

```bash
dotnet build games-vault.sln -c Release
dotnet test
```

Expected: build succeeds with 0 errors; tests pass.

**Step 5: Render-check the script tag**

Use a route that starts a session only if cleanup is planned:

```bash
curl -sS --max-time 20 http://127.0.0.1:8090/Games/PlayServer/1 \
  | grep -E 'nosebleed-player-config|server-player.js|server-player-shell|touch-gamepad'
systemctl restart games-vault
pgrep -x nosebleed -a || true
```

Expected: config block and static script tag are present; no leftover Nosebleed process after restart.

---

### Task 2: Add a compact mobile HUD row for status chips

**Objective:** Surface important state without covering gameplay.

**Files:**
- Modify: `Views/Games/PlayServer.cshtml`
- Modify: `wwwroot/js/nosebleed-player/server-player.js`

**Step 1: Add a non-obscuring HUD container**

Inside `#server-player-shell`, add:

```html
<div class="player-hud" aria-live="polite">
    <span id="nosebleed-connection-chip" class="player-chip">Connecting…</span>
    <span id="nosebleed-gamepad-chip" class="player-chip d-none">No gamepad</span>
</div>
```

Place it near the top edge, using small chips.

**Step 2: Add CSS**

```css
.player-hud {
    position: absolute;
    top: max(.75rem, env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    z-index: 6;
    display: flex;
    gap: .4rem;
    pointer-events: none;
}

.player-chip {
    border: 1px solid rgba(255,255,255,.35);
    background: rgba(15, 23, 42, .45);
    color: rgba(255,255,255,.86);
    border-radius: 999px;
    padding: .25rem .55rem;
    font-size: .72rem;
    backdrop-filter: blur(4px);
}

.player-chip.d-none { display: none !important; }
```

**Step 3: Wire existing connection status to chip**

Add:

```js
const connectionChip = document.getElementById("nosebleed-connection-chip");
const gamepadChip = document.getElementById("nosebleed-gamepad-chip");

function setConnectionChip(text) {
    if (connectionChip) connectionChip.textContent = text;
}
```

Update video/input/audio callbacks to call `setConnectionChip()` with short labels like `Video`, `Player 1`, `Spectator`, `Disconnected`.

**Step 4: Verify**

Render-check:

```bash
curl -sS --max-time 20 http://127.0.0.1:8090/Games/PlayServer/1 \
  | grep -E 'nosebleed-connection-chip|nosebleed-gamepad-chip|player-hud'
systemctl restart games-vault
```

Expected: HUD markup is present and no Nosebleed process remains after cleanup.

---

### Task 3: Improve hardware gamepad selection and status

**Objective:** Make browser Gamepad API support reliable enough for mobile Bluetooth controllers.

**Files:**
- Modify: `wwwroot/js/nosebleed-player/server-player.js`

**Step 1: Add gamepad state helpers**

Add:

```js
let activeGamepadIndex = null;

function getConnectedGamepads() {
    return Array.from(navigator.getGamepads?.() || []).filter(Boolean);
}

function selectGamepad() {
    const pads = getConnectedGamepads();
    if (activeGamepadIndex !== null && pads.some(p => p.index === activeGamepadIndex)) {
        return pads.find(p => p.index === activeGamepadIndex) ?? null;
    }

    const candidate = pads.find(p => (p.buttons?.length ?? 0) > 0 || (p.axes?.length ?? 0) > 0) ?? null;
    activeGamepadIndex = candidate?.index ?? null;
    updateGamepadChip(candidate);
    return candidate;
}

function updateGamepadChip(pad) {
    if (!gamepadChip) return;
    if (!pad) {
        gamepadChip.classList.add("d-none");
        gamepadChip.textContent = "No gamepad";
        return;
    }
    const label = pad.id ? pad.id.replace(/\s+/g, " ").trim().slice(0, 32) : `Gamepad ${pad.index + 1}`;
    gamepadChip.classList.remove("d-none");
    gamepadChip.textContent = `🎮 ${label}`;
}
```

**Step 2: Replace direct `navigator.getGamepads()[0]` polling**

Change:

```js
const pad = navigator.getGamepads?.()[0];
```

to:

```js
const pad = selectGamepad();
```

**Step 3: Add browser events**

```js
window.addEventListener("gamepadconnected", ev => {
    activeGamepadIndex = ev.gamepad.index;
    updateGamepadChip(ev.gamepad);
    setStatus(`Gamepad connected: ${ev.gamepad.id || `Gamepad ${ev.gamepad.index + 1}`}`);
});

window.addEventListener("gamepaddisconnected", ev => {
    if (activeGamepadIndex === ev.gamepad.index) activeGamepadIndex = null;
    updateGamepadChip(selectGamepad());
    setStatus("Gamepad disconnected.");
});
```

**Step 4: Add fallback initial detection after first user gesture**

In click/touch handlers for Connect/Fullscreen/Sound, call:

```js
updateGamepadChip(selectGamepad());
```

Some mobile browsers only expose gamepads after a button press or gesture.

**Step 5: Verify statically**

Render-check the JS contains:

```bash
grep -E 'gamepadconnected|gamepaddisconnected|selectGamepad|getConnectedGamepads|activeGamepadIndex' \
  wwwroot/js/nosebleed-player/server-player.js
```

Expected: all markers are present.

---

### Task 4: Add a lightweight gamepad tester/remapping aid

**Objective:** Help debug controller/browser mappings on mobile without changing persistent mappings yet.

**Files:**
- Modify: `Views/Games/PlayServer.cshtml`
- Modify: `wwwroot/js/nosebleed-player/server-player.js`

**Step 1: Add a collapsible tester below the player buttons**

Add a button near the lower controls:

```html
<button id="nosebleed-gamepad-test-toggle" class="btn btn-outline-secondary" type="button">Test gamepad</button>
```

Add a small panel:

```html
<div id="nosebleed-gamepad-test" class="text-muted small mt-2 d-none">
    Press buttons on your controller. Detected: <code id="nosebleed-gamepad-test-output">none</code>
</div>
```

**Step 2: Update tester output in the input loop**

Add:

```js
const gamepadTestToggle = document.getElementById("nosebleed-gamepad-test-toggle");
const gamepadTestPanel = document.getElementById("nosebleed-gamepad-test");
const gamepadTestOutput = document.getElementById("nosebleed-gamepad-test-output");
let gamepadTestVisible = false;

function updateGamepadTestOutput(pad) {
    if (!gamepadTestVisible || !gamepadTestOutput) return;
    if (!pad) {
        gamepadTestOutput.textContent = "none";
        return;
    }
    const pressed = [];
    pad.buttons?.forEach((button, index) => {
        if (button.pressed || button.value > 0.1) pressed.push(`b${index}:${button.value.toFixed(2)}`);
    });
    pad.axes?.forEach((value, index) => {
        if (Math.abs(value) > 0.25) pressed.push(`a${index}:${value.toFixed(2)}`);
    });
    gamepadTestOutput.textContent = pressed.join(" ") || "idle";
}
```

Call `updateGamepadTestOutput(pad)` inside `sendInput()` after selecting the pad.

**Step 3: Add toggle handler**

```js
gamepadTestToggle?.addEventListener("click", () => {
    gamepadTestVisible = !gamepadTestVisible;
    gamepadTestPanel?.classList.toggle("d-none", !gamepadTestVisible);
    updateGamepadChip(selectGamepad());
});
```

**Step 4: Verify**

Render-check:

```bash
curl -sS --max-time 20 http://127.0.0.1:8090/Games/PlayServer/1 \
  | grep -E 'nosebleed-gamepad-test|Test gamepad'
systemctl restart games-vault
```

Expected: tester markup is present and cleaned up after route verification.

---

### Task 5: Add reset-to-default overlay layout control

**Objective:** Let users recover from bad dragged/saved overlay positions.

**Files:**
- Modify: `Views/Games/PlayServer.cshtml`
- Modify: `wwwroot/js/nosebleed-player/server-player.js`

**Step 1: Add a reset button near layout controls**

Add an in-player button or lower-page button:

```html
<button id="nosebleed-layout-reset" class="btn btn-outline-secondary" type="button">Reset controls</button>
```

Prefer lower-page placement to avoid cluttering the player viewport.

**Step 2: Implement reset**

```js
const layoutResetButton = document.getElementById("nosebleed-layout-reset");

function resetLayout() {
    localStorage.removeItem(layoutStorageKey);
    for (const control of draggableControls) {
        control.style.left = "";
        control.style.top = "";
        control.style.right = "";
        control.style.bottom = "";
        control.style.transform = "";
    }
    setLayoutEditMode(false);
    setStatus("Control layout reset to defaults.");
}

layoutResetButton?.addEventListener("click", resetLayout);
```

**Step 3: Verify localStorage key remains layout-specific**

Confirm the key includes `touchLayoutName` and reset removes only that layout's key.

**Step 4: Verify**

Render-check:

```bash
grep -E 'nosebleed-layout-reset|resetLayout|removeItem\(layoutStorageKey' \
  Views/Games/PlayServer.cshtml wwwroot/js/nosebleed-player/server-player.js
```

Expected: reset UI and logic are present.

---

### Task 6: Improve fullscreen/mobile viewport ergonomics

**Objective:** Make fullscreen feel like an app on phones and avoid accidental browser gestures where possible.

**Files:**
- Modify: `Views/Games/PlayServer.cshtml`
- Modify: `wwwroot/js/nosebleed-player/server-player.js`

**Step 1: Add viewport-safe CSS refinements**

Add:

```css
.server-player-shell:fullscreen,
.server-player-shell:fullscreen * {
    overscroll-behavior: contain;
}

.server-player-shell:fullscreen .player-overlay-action,
.server-player-shell:fullscreen .touch-btn {
    -webkit-tap-highlight-color: transparent;
}
```

**Step 2: Add a short fullscreen hint status**

After entering fullscreen:

```js
setStatus("Fullscreen active. Double-tap empty video to exit; use Sound if audio is muted.");
```

**Step 3: Ensure fullscreen button and double-tap ignore edit controls**

Confirm double-tap guard includes:

```js
if (ev.target?.closest?.(".touch-btn, .player-overlay-action, [data-control-group]")) return;
```

**Step 4: Verify**

Static grep:

```bash
grep -E 'overscroll-behavior|tap-highlight|Fullscreen active|data-control-group' \
  Views/Games/PlayServer.cshtml wwwroot/js/nosebleed-player/server-player.js
```

Expected: all markers are present.

---

### Task 7: Add optional automatic touch-control dimming when hardware gamepad is active

**Objective:** Reduce visual clutter when a Bluetooth controller is being used while keeping touch controls available.

**Files:**
- Modify: `Views/Games/PlayServer.cshtml`
- Modify: `wwwroot/js/nosebleed-player/server-player.js`

**Step 1: Add CSS dim class**

```css
.touch-gamepad.hardware-active:not(.force-visible) {
    opacity: .22;
}

.touch-gamepad.hardware-active:not(.force-visible) .touch-btn {
    pointer-events: auto;
}
```

Do not hide controls entirely; dimming is safer on mobile.

**Step 2: Toggle class when gamepad has recent activity**

Add:

```js
let lastHardwareInputAt = 0;

function hasHardwareInput(pad) {
    if (!pad) return false;
    return (pad.buttons || []).some(b => b.pressed || b.value > 0.15)
        || (pad.axes || []).some(v => Math.abs(v) > 0.35);
}

function updateHardwareActivity(pad) {
    if (hasHardwareInput(pad)) lastHardwareInputAt = Date.now();
    const active = Date.now() - lastHardwareInputAt < 5000;
    touchGamepad?.classList.toggle("hardware-active", active);
}
```

Call it from `sendInput()` after selecting `pad`.

**Step 3: Verify touch toggle still works**

If user taps `Toggle controls`, `force-visible` should override dimming.

**Step 4: Verify**

Static grep:

```bash
grep -E 'hardware-active|lastHardwareInputAt|hasHardwareInput|updateHardwareActivity' \
  Views/Games/PlayServer.cshtml wwwroot/js/nosebleed-player/server-player.js
```

Expected: dimming markers are present.

---

### Task 8: Add mobile-friendly audio resilience

**Objective:** Make audio enablement clearer and prevent silent audio failure states.

**Files:**
- Modify: `wwwroot/js/nosebleed-player/server-player.js`

**Step 1: Add audio socket error/close handlers**

```js
audioWs.onerror = () => setStatus("Audio socket error. Tap Sound to retry.");
audioWs.onclose = () => {
    audioOverlayButton.textContent = "Sound";
    audioOverlayButton.classList.remove("is-on");
    audioOverlayButton.setAttribute("aria-label", "Enable sound");
};
```

**Step 2: Guard duplicate connecting sockets**

Add a state variable:

```js
let audioConnecting = false;
```

In `enableAudio()`, return early when `audioConnecting` is true, set it true before constructing the WebSocket, and false in `onopen`, `onerror`, and `onclose`.

**Step 3: Report browser Web Audio failure**

Wrap `audioCtx.resume()` in try/catch:

```js
try {
    await audioCtx.resume();
} catch {
    setStatus("Browser blocked audio. Tap Sound again after interacting with the page.");
    return;
}
```

**Step 4: Verify**

Static grep:

```bash
grep -E 'audioConnecting|Audio socket error|Browser blocked audio|Tap Sound to retry' \
  wwwroot/js/nosebleed-player/server-player.js
```

Expected: all markers are present.

---

### Task 9: Add latest-frame-only rendering for lower video latency

**Objective:** Reduce perceived latency by dropping stale video packets and painting only the newest frame on the browser's animation frame.

**Files:**
- Modify: `wwwroot/js/nosebleed-player/server-player.js` after Task 1 extraction
- If Task 1 is deferred, modify the script block in `Views/Games/PlayServer.cshtml` first, then move it during extraction.

**Step 1: Add pending-frame state**

Add:

```js
let pendingVideoFrame = null;
let renderLoopStarted = false;
let receivedVideoFrames = 0;
let droppedVideoFrames = 0;

function queueFrame(buffer) {
    if (pendingVideoFrame) droppedVideoFrames++;
    pendingVideoFrame = buffer;
    receivedVideoFrames++;
    if (!renderLoopStarted) {
        renderLoopStarted = true;
        requestAnimationFrame(renderLatestFrame);
    }
}

function renderLatestFrame() {
    if (pendingVideoFrame) {
        const frame = pendingVideoFrame;
        pendingVideoFrame = null;
        drawFrame(frame);
    }
    requestAnimationFrame(renderLatestFrame);
}
```

**Step 2: Use queueFrame in the video socket**

Change:

```js
videoWs.onmessage = ev => drawFrame(ev.data);
```

To:

```js
videoWs.onmessage = ev => queueFrame(ev.data);
```

**Step 3: Keep packet parsing unchanged**

Do not change `drawFrame()` packet parsing in this task. It should still parse `NBF0` packets and render exactly the same pixels.

**Step 4: Verify**

Static grep:

```bash
grep -E 'queueFrame|renderLatestFrame|pendingVideoFrame|droppedVideoFrames|requestAnimationFrame' \
  Views/Games/PlayServer.cshtml wwwroot/js/nosebleed-player/server-player.js 2>/dev/null
```

Expected: latest-frame-only markers are present.

---

### Task 10: Send immediate input on button edges

**Objective:** Make touch/keyboard button presses feel snappier by sending input immediately on transitions while retaining the 16ms steady input loop.

**Files:**
- Modify: `wwwroot/js/nosebleed-player/server-player.js` after Task 1 extraction
- If Task 1 is deferred, modify the script block in `Views/Games/PlayServer.cshtml` first, then move it during extraction.

**Step 1: Add a safe immediate-send helper**

Add:

```js
function sendInputNow() {
    if (layoutEditMode) return;
    sendInput();
}
```

`sendInput()` already guards spectator state, assigned port, and socket readiness.

**Step 2: Trigger immediate input from touch transitions**

In `setTouchButton(button, pressed)`, after updating `touchControls` and CSS, call:

```js
sendInputNow();
```

This makes touch `pointerdown` and `pointerup` send immediately.

**Step 3: Trigger immediate input from keyboard transitions**

Change keyboard listeners from one-liners to:

```js
window.addEventListener("keydown", ev => {
    const before = keys.size;
    keys.add(ev.code);
    if (ev.code.startsWith("Arrow")) ev.preventDefault();
    if (keys.size !== before) sendInputNow();
});

window.addEventListener("keyup", ev => {
    const hadKey = keys.delete(ev.code);
    if (ev.code.startsWith("Arrow")) ev.preventDefault();
    if (hadKey) sendInputNow();
});
```

**Step 4: Keep the 16ms loop**

Do not remove `setInterval(sendInput, 16)`. The immediate sends are extra edge updates, not a replacement.

**Step 5: Verify**

Static grep:

```bash
grep -E 'sendInputNow|keys.size !== before|hadKey\) sendInputNow|setInterval\(sendInput, 16\)' \
  Views/Games/PlayServer.cshtml wwwroot/js/nosebleed-player/server-player.js 2>/dev/null
```

Expected: immediate-send markers and existing steady loop are present.

---

### Task 11: Add lightweight latency/render stats to the debug HUD

**Objective:** Make latency work measurable enough to guide follow-up tuning without cluttering normal play.

**Files:**
- Modify: `Views/Games/PlayServer.cshtml`
- Modify: `wwwroot/js/nosebleed-player/server-player.js` after Task 1 extraction

**Step 1: Add a hidden stats chip/panel**

Add a small optional chip or lower-page panel:

```html
<button id="nosebleed-stats-toggle" class="btn btn-outline-secondary" type="button">Stats</button>
<span id="nosebleed-stats-chip" class="text-muted small d-none">Frames: --</span>
```

Prefer lower-page placement unless a HUD chip is already available from Task 2.

**Step 2: Track frame counters**

Use `receivedVideoFrames` and `droppedVideoFrames` from Task 9. Add a once-per-second updater:

```js
let statsVisible = false;
let lastStatsAt = performance.now();
let lastReceivedFrames = 0;

function updateStats() {
    if (!statsVisible || !statsChip) return;
    const now = performance.now();
    const elapsed = Math.max(0.001, (now - lastStatsAt) / 1000);
    const fps = (receivedVideoFrames - lastReceivedFrames) / elapsed;
    statsChip.textContent = `Video ${fps.toFixed(0)}fps · dropped ${droppedVideoFrames}`;
    lastStatsAt = now;
    lastReceivedFrames = receivedVideoFrames;
}

setInterval(updateStats, 1000);
```

**Step 3: Add toggle handler**

```js
statsToggle?.addEventListener("click", () => {
    statsVisible = !statsVisible;
    statsChip?.classList.toggle("d-none", !statsVisible);
    updateStats();
});
```

**Step 4: Verify**

Static grep:

```bash
grep -E 'nosebleed-stats-toggle|nosebleed-stats-chip|updateStats|droppedVideoFrames' \
  Views/Games/PlayServer.cshtml wwwroot/js/nosebleed-player/server-player.js 2>/dev/null
```

Expected: stats UI and frame counters are present.

---

### Task 12: Final integration verification and deploy

**Objective:** Confirm all mobile polish and easy latency improvements work together and deploy safely.

**Files:**
- No source changes unless fixing issues found during verification.

**Step 1: Build and test**

Run:

```bash
dotnet build games-vault.sln -c Release
dotnet test
```

Expected: build succeeds, tests pass.

**Step 2: Publish**

Run:

```bash
dotnet publish games-vault.csproj -c Release -o /opt/games-vault
systemctl restart games-vault
sleep 2
systemctl is-active games-vault
```

Expected: `active`.

**Step 3: Render-check local route and cleanup**

Run:

```bash
curl -sS --max-time 20 http://127.0.0.1:8090/Games/PlayServer/1 \
  | grep -E 'server-player.js|Unlock layout|Reset controls|Test gamepad|nosebleed-gamepad-chip|Sound'
systemctl restart games-vault
sleep 2
systemctl is-active games-vault
pgrep -x nosebleed -a || true
```

Expected:
- Markers are present.
- Service is active.
- No leftover Nosebleed process after cleanup restart.

**Step 4: Log check after final restart**

Run:

```bash
since=$(systemctl show games-vault -p ActiveEnterTimestamp --value)
journalctl -u games-vault --since "$since" --no-pager | grep -Ei 'fail:|crit:|Unhandled|permission|access denied|Exception' || true
```

Expected: no new severe errors since latest restart.

**Step 5: Manual phone test checklist**

On the phone:

- Open a Game Gear title in server-side mode.
- Enter fullscreen via double-tap or Fullscreen button.
- Tap Sound; confirm audio starts and button says `Sound on`.
- Move layout, save, reload, confirm layout persists.
- Reset controls, reload, confirm defaults return.
- Pair a Bluetooth controller, press a button, confirm gamepad chip appears.
- Confirm D-pad / `1` / `2` / Start respond with touch controls.
- Confirm hardware D-pad/buttons respond if the browser exposes the controller.

---

## Follow-up Ideas Not In This Plan

- Server-side persisted per-user overlay layouts instead of browser-only `localStorage`.
- Per-controller remapping profiles.
- Additional system-specific virtual layouts: NES, Master System, Genesis, SNES, Game Boy.
- Haptic feedback for touch button presses where supported.
- Wake Lock API to keep the screen awake during active play.
