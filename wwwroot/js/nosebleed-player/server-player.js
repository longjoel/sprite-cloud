(() => {
    const configEl = document.getElementById("nosebleed-player-config");
    if (!configEl) return;
    const config = JSON.parse(configEl.textContent || "{}");

    const baseUrl = config.baseUrl;
    const token = config.token;
    const websocketUrls = config.websocketUrls || {};
    const webrtcSessionUrl = config.webrtcSessionUrl;
    const assignedPort = config.assignedPort;
    const isSpectator = config.isSpectator;
    const isVisitor = config.isVisitor;
    const sessionId = config.sessionId;
    const touchLayoutName = config.touchLayoutName;
    const keepAliveUrl = config.keepAliveUrl;
    const bootstrapBatterySaveDiagnostics = Array.isArray(config.batterySaveDiagnostics) ? config.batterySaveDiagnostics : [];
    const statusEl = document.getElementById("nosebleed-status");
    const shell = document.getElementById("server-player-shell");
    const canvas = document.getElementById("nosebleed-screen");
    const rtcTrackVideo = document.getElementById("nosebleed-screen-video");
    const rtcTrackAudio = document.getElementById("nosebleed-rtc-audio");

    const SYSTEM_ASPECT_RATIOS = {
        "Nintendo - Nintendo 64": "4 / 3",
        "Nintendo - Super Nintendo Entertainment System": "4 / 3",
        "Nintendo - Nintendo Entertainment System": "4 / 3",
        "Nintendo - Game Boy": "10 / 9",
        "Nintendo - Game Boy Color": "10 / 9",
        "Nintendo - Game Boy Advance": "3 / 2",
        "Sega - Genesis/Mega Drive": "4 / 3",
        "Sega - Mega Drive": "4 / 3",
        "Sony - PlayStation": "4 / 3",
    };
    const DEFAULT_ASPECT_RATIO = "4 / 3";
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    const connectButton = document.getElementById("nosebleed-connect");
    const audioButton = document.getElementById("nosebleed-audio");
    const audioOverlayButton = document.getElementById("nosebleed-audio-overlay");
    const volumeSlider = document.getElementById("nosebleed-volume");
    const layoutLockButton = document.getElementById("nosebleed-layout-lock");
    const layoutResetButton = document.getElementById("nosebleed-layout-reset");
    const fullscreenButton = document.getElementById("nosebleed-fullscreen");
    const viewWindowedButton = document.getElementById("nosebleed-view-windowed");
    const viewTheaterButton = document.getElementById("nosebleed-view-theater");
    const overlayToggleButton = document.getElementById("nosebleed-overlay-toggle");
    const playerChrome = document.getElementById("nosebleed-player-chrome");
    const playerPrompt = document.getElementById("nosebleed-player-prompt");
    const playerEvents = document.getElementById("nosebleed-player-events");
    const playerHealth = document.getElementById("nosebleed-player-health");
    const playerHealthText = document.getElementById("nosebleed-player-health-text");
    const touchToggleButton = document.getElementById("nosebleed-touch-toggle");
    const loggingToggleButton = document.getElementById("nosebleed-logging-toggle");
    const playerLogPanel = document.getElementById("nosebleed-player-log");
    const playerLogList = document.getElementById("nosebleed-player-log-list");
    const playerLogClearButton = document.getElementById("nosebleed-player-log-clear");
    const saveStateSlotSelect = document.getElementById("nosebleed-save-state-slot");
    const saveStateSaveButton = document.getElementById("nosebleed-save-state-save");
    const saveStateLoadButton = document.getElementById("nosebleed-save-state-load");
    const videoTransportSelect = document.getElementById("nosebleed-video-transport");
    const videoCompressionSelect = document.getElementById("nosebleed-video-compression");
    const gamepadSelect = document.getElementById("nosebleed-gamepad-select");
    const padTestToggle = document.getElementById("nosebleed-pad-test-toggle");
    const padTestPanel = document.getElementById("nosebleed-pad-test-panel");
    const padTestSummary = document.getElementById("nosebleed-pad-test-summary");
    const padTestButtons = document.getElementById("nosebleed-pad-test-buttons");
    const padTestAxes = document.getElementById("nosebleed-pad-test-axes");
    const touchGamepad = document.getElementById("touch-gamepad");
    const touchButtons = Array.from(document.querySelectorAll(".touch-btn[data-button]"));
    const commandButtons = Array.from(document.querySelectorAll(".touch-btn[data-command]"));
    const dpadClusters = Array.from(document.querySelectorAll(".pad-cluster"));
    const draggableControls = Array.from(document.querySelectorAll("[data-control-group]"));
    const inputHelpers = window.GamesVaultNosebleedInput;
    const playerHelpers = window.GamesVaultNosebleedServerPlayer;
    const dpadButtonNames = new Set(inputHelpers?.DPAD_BUTTONS || ["up", "down", "left", "right"]);
    const chips = {
        video: document.getElementById("nosebleed-video-chip"),
        input: document.getElementById("nosebleed-input-chip"),
        pad: document.getElementById("nosebleed-pad-chip"),
        fps: document.getElementById("nosebleed-fps-chip"),
        status: document.getElementById("nosebleed-status-chip")
    };
    const layoutStorageKey = `games-vault:nosebleed-control-layout:${touchLayoutName}`;
    const overlayStorageKey = "games-vault:nosebleed-overlays-enabled";
    const logOverlayStorageKey = "games-vault:nosebleed-log-overlay-enabled";
    const saveStateSlotStorageKey = "games-vault:nosebleed-save-state-slot";
    const viewModeStorageKey = "games-vault:nosebleed-view-mode";
    const videoTransportStorageKey = "games-vault:nosebleed-video-transport";
    const videoCompressionStorageKey = "games-vault:nosebleed-video-compression";
    const volumeStorageKey = "games-vault:nosebleed-volume";
    const preferredGamepadIndex = Number.isInteger(assignedPort) ? assignedPort : null;
    const gamepadStorageKey = `games-vault:nosebleed-gamepad-index:${sessionId || "global"}:port:${assignedPort ?? "spectator"}`;
    const touchControls = new Set();
    let layoutEditMode = false;
    let activeDrag = null;
    let activeDpadPointer = null;
    let lastTapAt = 0;
    let inputWs = null;
    let rtcPeer = null;
    /** @type {RTCDataChannel|null} */
    let rtcInputDc = null;
    let activeVideoTransport = "idle";
    const configuredStreamDefaults = config.streamDefaults || {};
    const defaultVideoTransport = playerHelpers?.normalizeVideoTransportPreference?.(configuredStreamDefaults.videoTransport) ?? "webrtc-track";
    const defaultVideoCompression = playerHelpers?.normalizeVideoCompressionPreference?.(configuredStreamDefaults.videoCompression) ?? "balanced";
    let selectedVideoTransport = defaultVideoTransport;
    let selectedVideoCompression = defaultVideoCompression;
    let rtcTrackFrameCallbackActive = false;
    let rtcTrackAudioReady = false;
    let playbackDeferred = false;
    let inputSeq = 0;
    /** Auto-reconnect state */
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    let reconnectTimer = null;
    let intentionalDisconnect = false;
    let inputTimer = 0;
    /** @type {Worker|null} */
    let gamepadWorker = null;
    /** @type {import('./gamepad-worker').GamepadSnapshot|null} */
    let latestWorkerGamepadState = null;
    let keepAliveTimer = 0;
    let fpsTimer = 0;
    let framesThisSecond = 0;
    let pendingVideoFrame = null;
    let videoFrameScheduled = false;
    let videoFramesReceived = 0;
    let videoFramesDropped = 0;
    let videoRenderMs = 0;
    let selectedGamepadIndex = null;
    let preferredViewMode = normalizeViewMode(localStorage.getItem(viewModeStorageKey));
    let padTestTimer = 0;
    let gamepadPollTimer = 0;
    let audioEnabled = false;
    let audioVolume = Math.min(1, Math.max(0, Number.parseFloat(localStorage.getItem(volumeStorageKey) || "1") || 1));
    let overlaysEnabled = true;
    let logOverlayEnabled = localStorage.getItem(logOverlayStorageKey) === "true";
    let saveStateSlot = normalizeSaveStateSlot(localStorage.getItem(saveStateSlotStorageKey) || "1");
    let playerChromeTimer = 0;
    let playerPromptTimer = 0;
    const playerEventTimers = new WeakMap();
    const knownGamepads = new Map();
    const keys = new Set();

    function isFullscreenActive() {
        return document.fullscreenElement === shell || document.webkitFullscreenElement === shell || shell.classList.contains("is-ios-fullscreen");
    }

    function normalizeViewMode(mode) {
        return mode === "theater" ? "theater" : "windowed";
    }

    function normalizeSaveStateSlot(slot) {
        const parsed = Number.parseInt(String(slot ?? "1"), 10);
        if (!Number.isFinite(parsed)) {
            return 1;
        }
        return Math.min(5, Math.max(1, parsed));
    }

    function syncViewModeButtons() {
        const fullscreen = isFullscreenActive();
        const setButtonState = (button, active) => {
            if (!button) {
                return;
            }

            button.classList.toggle("btn-primary", active);
            button.classList.toggle("btn-outline-secondary", !active);
            button.setAttribute("aria-pressed", String(active));
        };

        setButtonState(viewWindowedButton, !fullscreen && preferredViewMode === "windowed");
        setButtonState(viewTheaterButton, !fullscreen && preferredViewMode === "theater");
        setButtonState(fullscreenButton, fullscreen);
    }

    function applyViewMode(mode, persist = true) {
        preferredViewMode = normalizeViewMode(mode);
        document.getElementById("playserver-session-grid")?.classList.toggle("view-mode-theater", preferredViewMode === "theater");
        if (persist) {
            localStorage.setItem(viewModeStorageKey, preferredViewMode);
        }
        syncViewModeButtons();
        fitCanvasToShell();
        fitRtcTrackVideoToShell();
    }

    function syncFullscreenUi() {
        const fullscreen = isFullscreenActive();
        if (fullscreenButton) {
            const label = fullscreen ? "Exit full screen" : "Full screen";
            fullscreenButton.setAttribute("aria-label", label);
            fullscreenButton.setAttribute("title", label);
        }
        document.documentElement.classList.toggle("games-vault-player-fullscreen", fullscreen);
        document.body?.classList.toggle("games-vault-player-fullscreen", fullscreen);
        const sidebar = document.querySelector(".playserver-sidebar-column");
        if (sidebar) {
            sidebar.classList.toggle("d-none", fullscreen);
        }
        syncViewModeButtons();
        fitCanvasToShell();
        fitRtcTrackVideoToShell();
    }

    function setPlayerChromeVisible(visible) {
        shell.classList.toggle("player-chrome-hidden", !visible || !overlaysEnabled);
    }

    function wakePlayerChrome(timeoutMs = 2200) {
        if (!overlaysEnabled) {
            setPlayerChromeVisible(false);
            return;
        }
        setPlayerChromeVisible(true);
        if (layoutEditMode) {
            return;
        }
        if (playerChromeTimer) {
            window.clearTimeout(playerChromeTimer);
        }
        playerChromeTimer = window.setTimeout(() => {
            if (!layoutEditMode) {
                setPlayerChromeVisible(false);
            }
        }, timeoutMs);
    }

    function showTransientPlayerPrompt(text, timeoutMs = 1500) {
        if (!playerPrompt) {
            return;
        }
        playerPrompt.textContent = text;
        playerPrompt.classList.add("show");
        wakePlayerChrome(Math.max(timeoutMs + 300, 2200));
        if (playerPromptTimer) {
            window.clearTimeout(playerPromptTimer);
        }
        playerPromptTimer = window.setTimeout(() => playerPrompt.classList.remove("show"), timeoutMs);
    }

    function showTransientPlayerEvent(message, tone = "warn", timeoutMs = 2600, title = null) {
        if (!playerEvents) {
            return;
        }
        const eventEl = document.createElement("div");
        eventEl.className = `player-event is-${tone}`;
        eventEl.innerHTML = `<span class="player-event-title">${title || (tone === "bad" ? "Connection issue" : tone === "good" ? "Recovered" : "Room update")}</span><span class="player-event-body">${message}</span>`;
        playerEvents.appendChild(eventEl);
        requestAnimationFrame(() => eventEl.classList.add("show"));
        wakePlayerChrome(Math.max(timeoutMs + 400, 2400));
        const cleanup = window.setTimeout(() => {
            eventEl.classList.remove("show");
            window.setTimeout(() => eventEl.remove(), 220);
        }, timeoutMs);
        playerEventTimers.set(eventEl, cleanup);
        logPlayerEvent(title || (tone === "bad" ? "Connection issue" : tone === "good" ? "Recovered" : "Room update"), message, tone);
    }

    function formatLogTimestamp(date = new Date()) {
        return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    }

    function setLogOverlayVisibility(enabled) {
        playerLogPanel?.classList.toggle("d-none", !enabled);
        if (loggingToggleButton) {
            const label = enabled ? "Hide logging overlay" : "Show logging overlay";
            loggingToggleButton.classList.toggle("is-on", enabled);
            loggingToggleButton.setAttribute("aria-pressed", String(enabled));
            loggingToggleButton.setAttribute("aria-label", label);
            loggingToggleButton.setAttribute("title", label);
        }
    }

    function clearPlayerLog() {
        if (!playerLogList) {
            return;
        }

        playerLogList.replaceChildren();
        const placeholder = document.createElement("li");
        placeholder.className = "player-log-entry text-muted";
        placeholder.dataset.placeholder = "true";
        placeholder.textContent = "No log entries yet.";
        playerLogList.appendChild(placeholder);
    }

    function appendPlayerLog(level, title, message) {
        if (!playerLogList) {
            return;
        }

        const normalizedLevel = ["good", "warn", "bad"].includes(level) ? level : "warn";
        const entry = document.createElement("li");
        entry.className = `player-log-entry is-${normalizedLevel}`;

        const meta = document.createElement("div");
        meta.className = "player-log-entry-meta";

        const titleEl = document.createElement("div");
        titleEl.className = "player-log-entry-title";
        titleEl.textContent = title;

        const timeEl = document.createElement("div");
        timeEl.className = "player-log-entry-time";
        timeEl.textContent = formatLogTimestamp();

        const bodyEl = document.createElement("div");
        bodyEl.className = "player-log-entry-body";
        bodyEl.textContent = message;

        meta.appendChild(titleEl);
        meta.appendChild(timeEl);
        entry.appendChild(meta);
        entry.appendChild(bodyEl);

        const placeholder = playerLogList.querySelector('[data-placeholder="true"]');
        if (placeholder) {
            placeholder.remove();
        }

        playerLogList.appendChild(entry);
        while (playerLogList.children.length > 80) {
            playerLogList.removeChild(playerLogList.firstElementChild);
        }
    }

    function setLogOverlayEnabled(enabled, persist = true) {
        logOverlayEnabled = enabled;
        setLogOverlayVisibility(enabled);
        if (persist) {
            localStorage.setItem(logOverlayStorageKey, String(enabled));
        }
        if (enabled && playerLogList && !playerLogList.children.length) {
            clearPlayerLog();
        }
    }

    function toggleLogOverlay() {
        const next = !logOverlayEnabled;
        setLogOverlayEnabled(next);
        appendPlayerLog("good", "Logs", next ? "Logging overlay opened." : "Logging overlay hidden.");
        wakePlayerChrome(2600);
    }

    function logPlayerStatus(text, tone = "warn") {
        appendPlayerLog(tone, "Status", text);
    }

    function logPlayerEvent(title, message, tone = "warn") {
        appendPlayerLog(tone, title, message);
    }

    function appendBatterySaveDiagnostics(entries) {
        if (!Array.isArray(entries) || entries.length === 0) {
            return;
        }

        for (const entry of entries) {
            if (!entry || typeof entry !== "object") {
                continue;
            }

            appendPlayerLog(
                typeof entry.level === "string" ? entry.level : "warn",
                typeof entry.title === "string" ? entry.title : "Battery saves",
                typeof entry.message === "string" ? entry.message : JSON.stringify(entry)
            );
        }
    }

    function setPlayerHealth(label, tone = "warn") {
        if (playerHealthText) {
            playerHealthText.textContent = label;
        }
        if (playerHealth) {
            playerHealth.classList.toggle("is-warn", tone === "warn");
            playerHealth.classList.toggle("is-bad", tone === "bad");
        }
    }

    function setStatus(text, tone = "warn") {
        if (statusEl) {
            statusEl.textContent = text;
        }
        updateChip(chips.status, text.replace(/[.…]+$/u, ""), tone);
        logPlayerStatus(text, tone);
    }

    function updateChip(chip, label, tone = "neutral") {
        if (!chip) return;
        const labelEl = chip.querySelector(".chip-label");
        if (labelEl) labelEl.textContent = label;
        chip.classList.toggle("is-good", tone === "good");
        chip.classList.toggle("is-warn", tone === "warn");
        chip.classList.toggle("is-bad", tone === "bad");
    }

    function showRtcTrackVideo() {
        if (!rtcTrackVideo) return;
        rtcTrackVideo.classList.remove("d-none");
        canvas.classList.add("d-none");
    }

    function hideRtcTrackVideo() {
        rtcTrackFrameCallbackActive = false;
        if (!rtcTrackVideo) {
            canvas.classList.remove("d-none");
            return;
        }
        try {
            const stream = rtcTrackVideo.srcObject;
            if (stream && typeof stream.getTracks === "function") {
                for (const track of stream.getTracks()) {
                    track.stop?.();
                }
            }
        } catch { }
        rtcTrackVideo.pause?.();
        rtcTrackVideo.srcObject = null;
        rtcTrackVideo.classList.add("d-none");
        canvas.classList.remove("d-none");
    }

    function fitSurfaceToShell(surfaceWidth, surfaceHeight, element) {
        if (!element || !surfaceWidth || !surfaceHeight) return;
        const shellRect = shell.getBoundingClientRect();
        const theaterMode = preferredViewMode === "theater" && !isFullscreenActive();
        const maxHeight = isFullscreenActive()
            ? window.innerHeight
            : theaterMode
                ? Math.min(window.innerHeight * 0.82, Math.max(1, shellRect.width * 0.85))
                : Math.min(window.innerHeight * 0.70, Math.max(1, shellRect.width));
        const availableWidth = Math.max(1, shellRect.width - 16);
        const availableHeight = Math.max(1, maxHeight);
        const size = playerHelpers?.calculateContainedSize?.(surfaceWidth, surfaceHeight, availableWidth, availableHeight)
            || { width: availableWidth, height: availableHeight };
        element.style.width = `${size.width}px`;
        element.style.height = `${size.height}px`;
    }

    function fitRtcTrackVideoToShell() {
        fitSurfaceToShell(rtcTrackVideo?.videoWidth || 0, rtcTrackVideo?.videoHeight || 0, rtcTrackVideo);
    }

    function scheduleRtcTrackFrameCallbacks() {
        if (activeVideoTransport !== "webrtc-track" || !rtcTrackVideo?.requestVideoFrameCallback || rtcTrackFrameCallbackActive) {
            return;
        }
        rtcTrackFrameCallbackActive = true;
        rtcTrackVideo.requestVideoFrameCallback(function step() {
            if (activeVideoTransport !== "webrtc-track" || !rtcTrackVideo) {
                rtcTrackFrameCallbackActive = false;
                return;
            }
            videoFramesReceived += 1;
            framesThisSecond += 1;
            videoRenderMs = 0;
            fitRtcTrackVideoToShell();
            rtcTrackVideo.requestVideoFrameCallback(step);
        });
    }

    function startPlayback() {
        if (!playbackDeferred) return;
        playbackDeferred = false;
        if (rtcTrackVideo) rtcTrackVideo.play?.().catch(() => { });
        if (rtcTrackAudio) rtcTrackAudio.play?.().catch(() => { });
    }

    function startHudTimers() {
        stopHudTimers();
        fpsTimer = window.setInterval(() => {
            const fps = framesThisSecond;
            framesThisSecond = 0;
            const stats = fps > 0 ? `${fps} fps · ${Math.round(videoRenderMs)}ms · ${videoFramesDropped} drop` : "0 fps";
            updateChip(chips.fps, stats, fps > 0 ? "good" : "warn");
            chips.fps?.setAttribute("title", `Received ${videoFramesReceived} frames, rendered ${fps} in the last second, dropped ${videoFramesDropped} queued frames, last render ${videoRenderMs.toFixed(1)}ms`);
            updatePadChip();
        }, 1000);
        updatePadChip();
    }

    function stopHudTimers() {
        if (fpsTimer) window.clearInterval(fpsTimer);
        fpsTimer = 0;
    }

    function rememberGamepad(pad) {
        if (!pad || !Number.isInteger(pad.index) || pad.connected === false) return null;
        knownGamepads.set(pad.index, pad);
        return pad;
    }

    function forgetGamepad(padOrIndex) {
        const index = typeof padOrIndex === "number" ? padOrIndex : padOrIndex?.index;
        if (Number.isInteger(index)) knownGamepads.delete(index);
    }

    function visibleBrowserGamepads() {
        return Array.from(navigator.getGamepads?.() || []).filter(pad => {
            if (!pad) return false;
            if (pad.connected === false) {
                forgetGamepad(pad);
                return false;
            }
            rememberGamepad(pad);
            return true;
        });
    }

    function connectedGamepads() {
        const padsByIndex = new Map();
        for (const pad of visibleBrowserGamepads()) padsByIndex.set(pad.index, pad);
        for (const pad of knownGamepads.values()) {
            if (pad?.connected !== false && !padsByIndex.has(pad.index)) {
                padsByIndex.set(pad.index, pad);
            }
        }

        return [...padsByIndex.values()].sort((left, right) => left.index - right.index);
    }

    function syncGamepadSelectionOptions() {
        if (!gamepadSelect) return;
        const pads = connectedGamepads();
        const currentValue = selectedGamepadIndex === null ? "" : String(selectedGamepadIndex);
        gamepadSelect.replaceChildren(new Option("Auto / keyboard", ""));
        for (const pad of pads) {
            const name = pad.id ? pad.id.split("(")[0].trim() : `Gamepad ${pad.index + 1}`;
            gamepadSelect.appendChild(new Option(`${pad.index + 1}: ${name}`, String(pad.index)));
        }
        if ([...gamepadSelect.options].some(option => option.value === currentValue)) {
            gamepadSelect.value = currentValue;
        } else {
            const fallback = playerHelpers?.chooseInitialGamepadIndex?.(connectedGamepads(), selectedGamepadIndex, preferredGamepadIndex) ?? null;
            selectedGamepadIndex = fallback;
            gamepadSelect.value = fallback === null ? "" : String(fallback);
            if (fallback === null) localStorage.removeItem(gamepadStorageKey);
            else localStorage.setItem(gamepadStorageKey, String(fallback));
        }
    }

    function refreshGamepadSelectionFromBrowser(eventGamepad = null) {
        if (eventGamepad) rememberGamepad(eventGamepad);
        if (!navigator.getGamepads && knownGamepads.size === 0) return false;
        const beforePad = getActiveGamepad();
        const nextIndex = playerHelpers?.chooseInitialGamepadIndex?.(connectedGamepads(), selectedGamepadIndex, preferredGamepadIndex) ?? selectedGamepadIndex;
        selectedGamepadIndex = nextIndex;
        syncGamepadSelectionOptions();
        const afterPad = getActiveGamepad();
        if (afterPad && afterPad !== beforePad) {
            updatePadChip();
            updatePadTestPanel();
            return true;
        }

        return false;
    }

    function primePreconnectedGamepads(event = null) {
        if (refreshGamepadSelectionFromBrowser(event?.gamepad || null)) {
            showTransientPlayerEvent("Controller detected.", "good", 2200, "Controller");
        }
    }

    function focusPlayerSurface() {
        if (document.activeElement === shell) return;
        try {
            shell.focus({ preventScroll: true });
        } catch {
            try { shell.focus(); } catch { }
        }
    }

    function getActiveGamepad() {
        const pads = navigator.getGamepads?.() || [];
        if (selectedGamepadIndex !== null) {
            const selectedPad = pads[selectedGamepadIndex] || null;
            if (selectedPad && selectedPad.connected !== false) return selectedPad;
            const knownPad = knownGamepads.get(selectedGamepadIndex) || null;
            if (knownPad && knownPad.connected !== false) return knownPad;
        }
        return connectedGamepads()[0] || null;
    }

    function describeGamepad(pad) {
        if (!pad) return "Pad none";
        const label = pad.id ? pad.id.split("(")[0].trim() : `Gamepad ${pad.index + 1}`;
        const shortLabel = label.length > 14 ? `${label.slice(0, 13)}…` : label;
        return selectedGamepadIndex === null ? shortLabel : `${pad.index + 1}: ${shortLabel}`;
    }

    function updatePadChip() {
        syncGamepadSelectionOptions();
        if (isSpectator) {
            updateChip(chips.pad, "Pad spectator", "warn");
            return;
        }
        const pad = getActiveGamepad();
        updateChip(chips.pad, describeGamepad(pad), pad ? "good" : "neutral");
    }

    function restoreGamepadSelection() {
        const saved = localStorage.getItem(gamepadStorageKey);
        if (saved !== null && saved !== "") {
            const parsed = Number.parseInt(saved, 10);
            if (Number.isInteger(parsed)) selectedGamepadIndex = parsed;
        }
        selectedGamepadIndex = playerHelpers?.chooseInitialGamepadIndex?.(connectedGamepads(), selectedGamepadIndex, preferredGamepadIndex) ?? selectedGamepadIndex;
        syncGamepadSelectionOptions();
        primePreconnectedGamepads();
    }

    function startGamepadPolling() {
        if (!navigator.getGamepads) return;
        stopGamepadPolling();
        gamepadPollTimer = window.setInterval(() => {
            const before = describeGamepad(getActiveGamepad());
            if (selectedGamepadIndex === null) {
                selectedGamepadIndex = playerHelpers?.chooseInitialGamepadIndex?.(connectedGamepads(), null, preferredGamepadIndex) ?? null;
            }
            syncGamepadSelectionOptions();
            const afterPad = getActiveGamepad();
            const after = describeGamepad(afterPad);
            if (before !== after) {
                updatePadChip();
                updatePadTestPanel();
            }
        }, 1000);
    }

    function stopGamepadPolling() {
        if (gamepadPollTimer) window.clearInterval(gamepadPollTimer);
        gamepadPollTimer = 0;
    }

    function startPadTest() {
        if (!padTestPanel) return;
        padTestPanel.classList.remove("d-none");
        padTestToggle?.setAttribute("aria-expanded", "true");
        padTestToggle?.classList.add("active");
        stopPadTest();
        updatePadTestPanel();
        padTestTimer = window.setInterval(updatePadTestPanel, 100);
    }

    function stopPadTest() {
        if (padTestTimer) window.clearInterval(padTestTimer);
        padTestTimer = 0;
    }

    function hidePadTest() {
        stopPadTest();
        padTestPanel?.classList.add("d-none");
        padTestToggle?.setAttribute("aria-expanded", "false");
        padTestToggle?.classList.remove("active");
    }

    function updatePadTestPanel() {
        if (!padTestPanel || padTestPanel.classList.contains("d-none")) return;
        const pad = getActiveGamepad();
        if (!pad) {
            padTestSummary.textContent = "No hardware gamepad detected. Press a button on the controller or pick it from the selector once the browser exposes it.";
            padTestButtons.textContent = "";
            padTestAxes.textContent = "";
            return;
        }
        const pressed = pad.buttons
            .map((button, index) => button.pressed ? `${index}${button.value > 0 && button.value < 1 ? `:${button.value.toFixed(2)}` : ""}` : null)
            .filter(Boolean);
        padTestSummary.textContent = `${pad.index + 1}: ${pad.id || "Gamepad"}`;
        padTestButtons.textContent = pressed.length > 0 ? `Pressed buttons: ${pressed.join(", ")}` : "Pressed buttons: none";
        padTestAxes.textContent = `Axes: ${pad.axes.map((axis, index) => `${index}:${axis.toFixed(2)}`).join("  ")}`;
    }

    function withToken(path, options = {}) {
        const proxyUrl = path === "/ws/input"
            ? websocketUrls.input
            : null;
        if (proxyUrl) {
            const url = new URL(proxyUrl, window.location.href);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            return url.toString();
        }
        if (!baseUrl) throw new Error(`No WebSocket URL configured for ${path}`);
        const url = new URL(path, baseUrl);
        if (token) url.searchParams.set("token", token);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.toString();
    }

    async function connect() {
        closeSockets();
        setStatus("Connecting…");
        setPlayerHealth("Connecting…", "warn");
        wakePlayerChrome(3200);
        updateChip(chips.video, "Video connecting", "warn");
        updateChip(chips.input, isSpectator ? "Spectator" : "Input connecting", "warn");
        startHudTimers();

        const queryOverrides = (() => {
            try {
                const params = new URLSearchParams(window.location.search);
                return {
                    transport: params.get("videoTransport"),
                    compression: params.get("videoCompression")
                };
            } catch {
                return { transport: null, compression: null };
            }
        })();
        selectedVideoTransport = playerHelpers?.normalizeVideoTransportPreference?.(queryOverrides.transport || selectedVideoTransport) ?? "webrtc-track";
        selectedVideoCompression = playerHelpers?.normalizeVideoCompressionPreference?.(queryOverrides.compression || selectedVideoCompression) ?? "balanced";
        syncVideoPreferenceControls();
        const videoTransport = playerHelpers?.chooseVideoTransport?.({
            rtcSupported: typeof RTCPeerConnection !== "undefined",
            webrtcSessionUrl,
            preferredTransport: selectedVideoTransport
        }) ?? "webrtc";
        if (videoTransport === "webrtc-track") {
            await connectWebRtcTrackVideo();
        }

        if (!isSpectator && assignedPort !== null) {
            inputWs = new WebSocket(withToken("/ws/input"));
            inputWs.onopen = () => {
                focusPlayerSurface();
                primePreconnectedGamepads();
                updateChip(chips.input, `P${assignedPort + 1} input`, "good");
                setStatus(`Connected as Player ${assignedPort + 1}. Sending input.`, "good");
                setPlayerHealth(`Controller live · P${assignedPort + 1}`, "good");
                showTransientPlayerEvent(`Controller live again on seat ${assignedPort + 1}.`, "good", 2200, "Recovered");
                startInputLoop();
            };
            inputWs.onmessage = ev => {
                try {
                    const message = JSON.parse(ev.data);
                    if (message?.type === "error" && message.message) {
                        setStatus(message.message, "bad");
                        showTransientPlayerEvent(message.message, "bad", 3200);
                    }
                } catch {
                    // Ignore malformed/non-JSON runtime messages.
                }
            };
            inputWs.onerror = () => {
                updateChip(chips.input, "Input error", "bad");
                setStatus("Input socket error.", "bad");
                setPlayerHealth("Controller error", "bad");
                showTransientPlayerEvent("Controller socket error.", "bad", 3200, "Connection issue");
            };
            inputWs.onclose = () => {
                updateChip(chips.input, "Input offline", "bad");
                setStatus("Controller socket disconnected.", "bad");
                setPlayerHealth("Controller offline", "bad");
                showTransientPlayerEvent("Controller socket disconnected.", "bad", 3200, "Connection issue");
                stopInputLoop();
                scheduleReconnect();
            };
        } else {
            updateChip(chips.input, "Spectator", "warn");
            setStatus("Connected as spectator. Input disabled.", "warn");
            setPlayerHealth("Watching live", "warn");
        }
        startSeatKeepAlive();
    }

    async function connectWebRtcTrackVideo() {
        if (typeof RTCPeerConnection === "undefined" || !webrtcSessionUrl) return false;
        try {
            activeVideoTransport = "webrtc-track";
            hideRtcTrackVideo();
            rtcPeer = new RTCPeerConnection({
                iceServers: [
                    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
                    { urls: ["turns:lngnckr.tech:443?transport=tcp", "turns:lngnckr.tech:5349?transport=tcp"], username: "nosebleed", credential: "118e21c57679b3293d7a0b9adfd90ea7" }
                ]
            });
            rtcPeer.addTransceiver("video", { direction: "recvonly" });
            rtcPeer.addTransceiver("audio", { direction: "recvonly" });
            rtcPeer.ontrack = event => {
                const stream = event.streams?.[0] ?? new MediaStream([event.track]);
                if (event.track.kind === "audio") {
                    rtcTrackAudioReady = true;
                    if (rtcTrackAudio && rtcTrackAudio.srcObject !== stream) {
                        rtcTrackAudio.srcObject = stream;
                    }
                    if (audioEnabled && rtcTrackAudio) {
                        rtcTrackAudio.muted = false;
                        applyAudioVolume(false);
                        setAudioEnabledUi();
                        setStatus("Audio connected (webrtc track).", "good");
                    }
                    return;
                }

                if (!rtcTrackVideo) return;
                if (rtcTrackVideo.srcObject !== stream) {
                    rtcTrackVideo.srcObject = stream;
                }
                showRtcTrackVideo();
                fitRtcTrackVideoToShell();
                scheduleRtcTrackFrameCallbacks();
                updateChip(chips.video, "Video live (track)", "good");
                setStatus("Video connected (webrtc track).", "good");
                playbackDeferred = true;
            };

            rtcPeer.onconnectionstatechange = () => {
                console.log(`[nosebleed] PC state: ${rtcPeer.connectionState}`);
                if (rtcPeer.connectionState === "failed") {
                    console.warn("[nosebleed] ICE connection failed — UDP likely blocked");
                    setStatus("WebRTC connection failed (VPN blocking UDP?)", "bad");
                }
            };
            rtcPeer.oniceconnectionstatechange = () => {
                console.log(`[nosebleed] ICE state: ${rtcPeer.iceConnectionState}`);
            };
            rtcPeer.onicecandidate = (event) => {
                if (event.candidate) {
                    console.log(`[nosebleed] ICE candidate: ${event.candidate.candidate}`);
                }
            };

            // Incoming data channels from the server - "input" for low-latency input
            rtcPeer.ondatachannel = (ev) => {
                if (ev.channel.label === "input") {
                    rtcInputDc = ev.channel;
                    rtcInputDc.binaryType = "arraybuffer";
                    rtcInputDc.onopen = () => updateChip(chips.input, "Input (rtc)", "good");
                    rtcInputDc.onclose = () => {
                        if (rtcInputDc === ev.channel) rtcInputDc = null;
                    };
                }
            };

            // Create input data channel so gamepad/keyboard input can flow over WebRTC.
            // Created BEFORE createOffer so it is included in the offer SDP.
            rtcInputDc = rtcPeer.createDataChannel("input", { negotiated: true, id: 0 });
            rtcInputDc.binaryType = "arraybuffer";
            rtcInputDc.onopen = () => updateChip(chips.input, "Input (rtc)", "good");
            rtcInputDc.onclose = () => { rtcInputDc = null; };

            const offer = await rtcPeer.createOffer();
            await rtcPeer.setLocalDescription(offer);
            await waitForIceGatheringComplete(rtcPeer);
            if (!rtcPeer.localDescription) return false;

            const response = await fetch(new URL(webrtcSessionUrl, window.location.href).toString(), {
                method: "POST",
                headers: { 
                    "content-type": "application/json",
                    "X-CSRF-TOKEN": document.querySelector('input[name="__RequestVerificationToken"]')?.value ?? ''
                },
                body: JSON.stringify({ type: rtcPeer.localDescription.type, sdp: rtcPeer.localDescription.sdp, video_mode: "track-vp8" })
            });
            if (!response.ok) throw new Error(`webrtc signaling failed: ${response.status}`);
            const answer = await response.json();
            await rtcPeer.setRemoteDescription(answer);
            return true;
        } catch (err) {
            console.warn("webrtc track video setup failed, fallback to websocket", err);
            try { rtcPeer?.close(); } catch { }
            rtcPeer = null;
            activeVideoTransport = "idle";
            hideRtcTrackVideo();
            return false;
        }
    }

    function closeSockets() {
        stopInputLoop();
        stopSeatKeepAlive();
        stopHudTimers();
        activeVideoTransport = "idle";
        hideRtcTrackVideo();
        updateChip(chips.video, "Video idle", "warn");
        updateChip(chips.input, isSpectator ? "Spectator" : "Input idle", "warn");
        updateChip(chips.fps, "0 fps", "neutral");
        framesThisSecond = 0;
        videoFramesReceived = 0;
        videoFramesDropped = 0;
        videoRenderMs = 0;
        pendingVideoFrame = null;
        videoFrameScheduled = false;
        try { inputWs?.close(); } catch { }
        try { rtcInputDc?.close(); } catch { }
        try { rtcPeer?.close(); } catch { }
        rtcInputDc = null;
        rtcPeer = null;
        rtcTrackAudioReady = false;
        playbackDeferred = false;
        if (rtcTrackAudio) {
            try { rtcTrackAudio.pause?.(); } catch { }
            rtcTrackAudio.muted = true;
            rtcTrackAudio.srcObject = null;
        }
        inputWs = null;
        audioEnabled = false;
        setAudioDisabledUi();
    }

    function syncVideoPreferenceControls() {
        if (videoTransportSelect) videoTransportSelect.value = selectedVideoTransport;
        if (videoCompressionSelect) videoCompressionSelect.value = selectedVideoCompression;
    }

    function saveVideoPreferences() {
        localStorage.setItem(videoTransportStorageKey, selectedVideoTransport);
        localStorage.setItem(videoCompressionStorageKey, selectedVideoCompression);
        syncVideoPreferenceControls();
    }

    function reconnectForVideoPreferenceChange(message) {
        saveVideoPreferences();
        setStatus(message, "good");
        showTransientPlayerEvent(message, "good", 2400, "Stream updated");
        clearReconnect();
        connect().catch(() => { });
    }

    function clearReconnect() {
        intentionalDisconnect = true;
        reconnectAttempts = 0;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    }

    function scheduleReconnect() {
        if (intentionalDisconnect) {
            intentionalDisconnect = false;
            return;
        }
        if (reconnectAttempts >= maxReconnectAttempts) {
            setStatus("Max reconnect attempts reached. Click Connect to retry.", "bad");
            return;
        }
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000) + Math.round(Math.random() * 1000);
        reconnectAttempts++;
        setStatus(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts}/${maxReconnectAttempts})…`, "warn");
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!intentionalDisconnect) {
                connect().catch(() => scheduleReconnect());
            }
        }, delay);
    }

    function fitCanvasToShell() {
        fitSurfaceToShell(canvas.width, canvas.height, canvas);
    }

    function startInputLoop() {
        stopInputLoop();
        // Spawn gamepad worker for off-main-thread polling
        try {
            gamepadWorker = new Worker("/js/nosebleed-player/gamepad-worker.js", { type: "module" });
            gamepadWorker.addEventListener("message", (ev) => {
                if (ev.data?.type === "gamepad-state") {
                    // Store the first connected pad that matches our selection preference
                    const pads = ev.data.pads || [];
                    const selected = selectedGamepadIndex;
                    const match = selected !== null
                        ? pads.find(p => p.index === selected)
                        : pads[0] || null;
                    latestWorkerGamepadState = match;
                    if (pads.length > 0) syncGamepadSelectionOptions();
                } else if (ev.data?.type === "gamepad-disconnected") {
                    forgetGamepad(ev.data.index);
                    syncGamepadSelectionOptions();
                    updatePadChip();
                }
            });
            gamepadWorker.postMessage({ type: "start" });
        } catch {
            // Worker unsupported or blocked — fall back to main-thread polling
            gamepadWorker = null;
        }
        inputTimer = window.setInterval(sendBinaryInput, 16);
    }
    function stopInputLoop() {
        if (gamepadWorker) {
            try { gamepadWorker.postMessage({ type: "stop" }); } catch { }
            try { gamepadWorker.terminate(); } catch { }
            gamepadWorker = null;
        }
        latestWorkerGamepadState = null;
        if (inputTimer) window.clearInterval(inputTimer);
        inputTimer = 0;
    }

    /**
     * Binary-encode the current input state and send over WebSocket.
     *
     * Uses the latest Web Worker gamepad snapshot when available, falling
     * back to main-thread navigator.getGamepads().
     *
     * Wire format: 34 bytes (little-endian) — see InputBinary in nosebleed.
     */
    function clampAxis(v) {
        if (Math.abs(v) < 0.15) return 0;
        return Math.max(-1, Math.min(1, v));
    }

    function sendBinaryInput() {
        if (isSpectator || assignedPort === null) return;
        // Prefer WebRTC data channel (lower latency), fall back to WebSocket
        if (!rtcInputDc || rtcInputDc.readyState !== "open") {
            if (!inputWs || inputWs.readyState !== WebSocket.OPEN) return;
        }
        const pad = latestWorkerGamepadState ?? getActivePadFromMainThread();
        const buf = new ArrayBuffer(34);
        const dv = new DataView(buf);

        let buttons = 0;
        // retro_id 0 (B): gamepad button 0, keyboard X
        if (keys.has("KeyX") || touchControls.has("b") || pad?.buttons?.[0]?.pressed) buttons |= 1 << 0;
        // retro_id 1 (Y): gamepad button 3
        if (touchControls.has("y") || pad?.buttons?.[3]?.pressed) buttons |= 1 << 1;
        // retro_id 2 (Select): gamepad button 8, Shift
        if (keys.has("ShiftLeft") || keys.has("ShiftRight") || touchControls.has("select") || pad?.buttons?.[8]?.pressed) buttons |= 1 << 2;
        // retro_id 3 (Start): gamepad button 9, Enter
        if (keys.has("Enter") || touchControls.has("start") || pad?.buttons?.[9]?.pressed) buttons |= 1 << 3;
        // retro_id 4 (Up): gamepad button 12, ArrowUp, axis y < -0.5
        if (keys.has("ArrowUp") || touchControls.has("up") || pad?.buttons?.[12]?.pressed || (pad?.axes?.[1] ?? 0) < -0.5) buttons |= 1 << 4;
        // retro_id 5 (Down): gamepad button 13, ArrowDown, axis y > 0.5
        if (keys.has("ArrowDown") || touchControls.has("down") || pad?.buttons?.[13]?.pressed || (pad?.axes?.[1] ?? 0) > 0.5) buttons |= 1 << 5;
        // retro_id 6 (Left): gamepad button 14, ArrowLeft, axis x < -0.5
        if (keys.has("ArrowLeft") || touchControls.has("left") || pad?.buttons?.[14]?.pressed || (pad?.axes?.[0] ?? 0) < -0.5) buttons |= 1 << 6;
        // retro_id 7 (Right): gamepad button 15, ArrowRight, axis x > 0.5
        if (keys.has("ArrowRight") || touchControls.has("right") || pad?.buttons?.[15]?.pressed || (pad?.axes?.[0] ?? 0) > 0.5) buttons |= 1 << 7;
        // retro_id 8 (A): gamepad button 1, keyboard Z
        if (keys.has("KeyZ") || touchControls.has("a") || pad?.buttons?.[1]?.pressed) buttons |= 1 << 8;
        // retro_id 9 (X): gamepad button 2
        if (touchControls.has("x") || pad?.buttons?.[2]?.pressed) buttons |= 1 << 9;
        // retro_id 10 (L1 / N64 L): gamepad button 10, keyboard A
        if (keys.has("KeyA") || touchControls.has("l") || pad?.buttons?.[10]?.pressed) buttons |= 1 << 10;
        // retro_id 11 (R1 / N64 R): gamepad button 11, keyboard S
        if (keys.has("KeyS") || touchControls.has("r") || pad?.buttons?.[11]?.pressed) buttons |= 1 << 11;
        // retro_id 12 (L2 / N64 Z): gamepad button 6, keyboard D
        if (keys.has("KeyD") || pad?.buttons?.[6]?.pressed) buttons |= 1 << 12;
        // retro_id 13 (R2): gamepad button 7
        if (pad?.buttons?.[7]?.pressed) buttons |= 1 << 13;

        // Row 0: sequence (u16 LE) + port (u32 LE)
        dv.setUint16(0, ++inputSeq & 0xffff, true);
        dv.setUint32(2, assignedPort, true);
        // Row 1: buttons bitmask (u32 LE)
        dv.setUint32(6, buttons, true);
        // Rows 2-4: axes (f32 LE)
        // Left stick: gamepad left stick or arrow keys (digital → ±1.0)
        let lx = pad?.axes?.[0] ?? 0;
        let ly = pad?.axes?.[1] ?? 0;
        dv.setFloat32(10, lx, true);  // lx
        dv.setFloat32(14, ly, true);  // ly
        // Right stick / N64 C-buttons: gamepad right stick or I/J/K/L keys
        let rkx = (keys.has("KeyJ") ? -1.0 : 0.0) + (keys.has("KeyL") ? 1.0 : 0.0);
        let rky = (keys.has("KeyI") ? -1.0 : 0.0) + (keys.has("KeyK") ? 1.0 : 0.0);
        let rx = clampAxis(pad?.axes?.[2] ?? 0) || rkx;
        let ry = clampAxis(pad?.axes?.[3] ?? 0) || rky;
        dv.setFloat32(18, rx, true);  // rx (C-Left/C-Right)
        dv.setFloat32(22, ry, true);  // ry (C-Up/C-Down)
        dv.setFloat32(26, pad?.buttons?.[6]?.value ?? 0, true);  // lt (L2)
        dv.setFloat32(30, pad?.buttons?.[7]?.value ?? 0, true);  // rt (R2)

        if (rtcInputDc?.readyState === "open") {
            rtcInputDc.send(buf);
        } else {
            inputWs.send(buf);
        }
    }

    /**
     * Fallback: read gamepad state from the main thread.
     * Used when the Web Worker is unavailable.
     */
    function getActivePadFromMainThread() {
        const pads = navigator.getGamepads?.() || [];
        const idx = selectedGamepadIndex;
        if (idx !== null && pads[idx]?.connected) return pads[idx];
        // Fall back to the first connected pad
        for (let i = 0; i < pads.length; i++) {
            if (pads[i]?.connected) return pads[i];
        }
        return null;
    }

    function sendInputImmediately() {
        try { sendBinaryInput(); } catch { }
    }

    function flashCommandButton(button) {
        if (!button) return;
        button.classList.add("is-pressed");
        window.setTimeout(() => button.classList.remove("is-pressed"), 150);
    }

    function syncSaveStateSlotUi() {
        if (saveStateSlotSelect) {
            saveStateSlotSelect.value = String(saveStateSlot);
        }
    }

    function setSaveStateSlot(slot, persist = true) {
        saveStateSlot = normalizeSaveStateSlot(slot);
        syncSaveStateSlotUi();
        if (persist) {
            localStorage.setItem(saveStateSlotStorageKey, String(saveStateSlot));
        }
    }

    function sendCommand(command, button = null, port = assignedPort ?? 0) {
        if (isVisitor && (command === "reset" || command === "insert_coin")) {
            setStatus("Only arcade operators can use that control.", "warn");
            return false;
        }

        if (isSpectator || assignedPort === null || !inputWs || inputWs.readyState !== WebSocket.OPEN) {
            setStatus("Connect as a player before sending arcade commands.", "warn");
            return false;
        }

        flashCommandButton(button);
        inputWs.send(JSON.stringify({ type: "command", command, port, sequence: ++inputSeq }));
        if (command === "insert_coin") {
            setStatus(`Coin inserted for Player ${assignedPort + 1}.`, "good");
        } else if (command === "reset") {
            setStatus("Reset command sent to the machine.", "good");
        }

        return true;
    }

    function sendStateCommand(command, button = null) {
        if (isVisitor) {
            setStatus("Only arcade operators can use that control.", "warn");
            return false;
        }

        if (isSpectator || assignedPort === null || !inputWs || inputWs.readyState !== WebSocket.OPEN) {
            setStatus("Connect as a player before sending state commands.", "warn");
            return false;
        }

        const slot = normalizeSaveStateSlot(saveStateSlotSelect?.value ?? saveStateSlot);
        setSaveStateSlot(slot, true);
        flashCommandButton(button);
        inputWs.send(JSON.stringify({ type: "command", command, slot, port: assignedPort, sequence: ++inputSeq }));
        if (command === "save_state") {
            setStatus(`Save state slot ${slot} queued.`, "good");
        } else if (command === "load_state") {
            setStatus(`Load state slot ${slot} queued.`, "good");
        }
        wakePlayerChrome(2600);
        return true;
    }

    function startSeatKeepAlive() {
        stopSeatKeepAlive();
        sendSeatKeepAlive();
        keepAliveTimer = window.setInterval(sendSeatKeepAlive, 60000);
    }

    function stopSeatKeepAlive() {
        if (keepAliveTimer) window.clearInterval(keepAliveTimer);
        keepAliveTimer = 0;
    }

    async function sendSeatKeepAlive() {
        if (!sessionId || !keepAliveUrl) return;
        try {
            const csrfToken = document.querySelector('input[name="__RequestVerificationToken"]')?.value ?? '';
            const response = await fetch(keepAliveUrl, {
                method: "POST",
                headers: { 
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-CSRF-TOKEN": csrfToken
                },
                body: new URLSearchParams({ sessionId }),
                credentials: "same-origin"
            });
            if (!response.ok) return;
            const assignment = await response.json();
            if ((isSpectator && assignment.kind === "player") ||
                (!isSpectator && assignment.port !== assignedPort)) {
                window.location.reload();
            }
        } catch {
            // Keep playback running even if the seat heartbeat briefly fails.
        }
    }

    function sendInput() {
        if (isSpectator || assignedPort === null || !inputWs || inputWs.readyState !== WebSocket.OPEN) return;
        const pad = getActiveGamepad();
        const buttons = {
            a: keys.has("KeyZ") || touchControls.has("a") || !!pad?.buttons[1]?.pressed,
            b: keys.has("KeyX") || touchControls.has("b") || !!pad?.buttons[0]?.pressed,
            x: touchControls.has("x") || !!pad?.buttons[2]?.pressed,
            y: touchControls.has("y") || !!pad?.buttons[3]?.pressed,
            select: keys.has("ShiftLeft") || keys.has("ShiftRight") || touchControls.has("select") || !!pad?.buttons[8]?.pressed,
            start: keys.has("Enter") || touchControls.has("start") || !!pad?.buttons[9]?.pressed,
            up: keys.has("ArrowUp") || touchControls.has("up") || !!pad?.buttons[12]?.pressed || ((pad?.axes[1] ?? 0) < -0.5),
            down: keys.has("ArrowDown") || touchControls.has("down") || !!pad?.buttons[13]?.pressed || ((pad?.axes[1] ?? 0) > 0.5),
            left: keys.has("ArrowLeft") || touchControls.has("left") || !!pad?.buttons[14]?.pressed || ((pad?.axes[0] ?? 0) < -0.5),
            right: keys.has("ArrowRight") || touchControls.has("right") || !!pad?.buttons[15]?.pressed || ((pad?.axes[0] ?? 0) > 0.5)
        };
        const axes = {
            lx: pad?.axes[0] ?? 0,
            ly: pad?.axes[1] ?? 0,
            rx: pad?.axes[2] ?? 0,
            ry: pad?.axes[3] ?? 0,
            l2: pad?.buttons[6]?.value ?? 0,
            r2: pad?.buttons[7]?.value ?? 0
        };
        inputWs.send(JSON.stringify({ type: "input", port: assignedPort, sequence: ++inputSeq, buttons, axes }));
    }

    async function enableAudio() {
        audioEnabled = true;
        wakePlayerChrome(2600);
        if (activeVideoTransport === "webrtc-track" && rtcTrackAudio) {
            rtcTrackAudio.muted = false;
            applyAudioVolume(false);
            try { await rtcTrackAudio.play?.(); } catch { }
            setAudioEnabledUi();
            setStatus(rtcTrackAudioReady ? "Audio connected (webrtc track)." : "Audio will start when the WebRTC track arrives.", "good");
            showTransientPlayerPrompt("Audio enabled");
            return;
        }
        showTransientPlayerPrompt("Audio enabled");
    }

    async function disableAudio() {
        audioEnabled = false;
        if (rtcTrackAudio) {
            rtcTrackAudio.muted = true;
            try { rtcTrackAudio.pause?.(); } catch { }
        }
        setAudioDisabledUi();
        setStatus("Audio muted.", "good");
        wakePlayerChrome(2400);
        showTransientPlayerPrompt("Audio muted");
    }

    async function toggleAudio() {
        if (playerHelpers?.nextAudioEnabledState?.(audioEnabled)) await enableAudio();
        else await disableAudio();
    }

    function setVolumeSliderUi(normalized) {
        if (!volumeSlider) {
            return;
        }

        const percent = Math.round(normalized * 100);
        if (volumeSlider instanceof HTMLInputElement) {
            volumeSlider.value = String(percent);
            return;
        }

        volumeSlider.style.setProperty("--volume-fill", `${percent}%`);
        volumeSlider.setAttribute("aria-valuenow", String(percent));
        volumeSlider.setAttribute("aria-valuetext", `${percent} percent`);
    }

    function setVolumeFromPoint(clientX) {
        if (!volumeSlider) {
            return;
        }

        const rect = volumeSlider.getBoundingClientRect();
        if (rect.width <= 0) {
            return;
        }

        audioVolume = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        applyAudioVolume();
        wakePlayerChrome(2600);
    }

    function setVolumeFromKey(key) {
        const step = key === "ArrowLeft" || key === "ArrowDown" ? -0.05 : 0.05;
        if (key === "Home") {
            audioVolume = 0;
        } else if (key === "End") {
            audioVolume = 1;
        } else {
            audioVolume = Math.min(1, Math.max(0, audioVolume + step));
        }

        applyAudioVolume();
        wakePlayerChrome(2600);
    }

    function applyAudioVolume(persist = true) {
        const normalized = Math.min(1, Math.max(0, Number.isFinite(audioVolume) ? audioVolume : 1));
        audioVolume = normalized;
        if (rtcTrackAudio) {
            rtcTrackAudio.volume = normalized;
        }
        setVolumeSliderUi(normalized);
        if (persist) {
            localStorage.setItem(volumeStorageKey, String(normalized));
        }
    }

    function syncOverlayAudioUi(enabled) {
        if (!audioOverlayButton) {
            return;
        }
        audioOverlayButton.classList.toggle("is-on", enabled);
        audioOverlayButton.classList.toggle("is-muted", !enabled);
        audioOverlayButton.setAttribute("aria-label", enabled ? "Mute sound" : "Enable sound");
        audioOverlayButton.setAttribute("title", enabled ? "Mute sound" : "Enable sound");
        const labelEl = audioOverlayButton.querySelector(".player-control-label");
        if (labelEl) {
            labelEl.textContent = enabled ? "Mute" : "Sound";
        }
    }

    function setAudioEnabledUi() {
        if (audioButton) {
            audioButton.textContent = "Mute audio";
            audioButton.classList.remove("btn-outline-secondary");
            audioButton.classList.add("btn-success");
            audioButton.classList.add("primary");
        }
        syncOverlayAudioUi(true);
        applyAudioVolume(false);
    }

    function setAudioDisabledUi() {
        if (audioButton) {
            audioButton.textContent = "Enable audio";
            audioButton.classList.add("btn-outline-secondary");
            audioButton.classList.remove("btn-success");
            audioButton.classList.remove("primary");
        }
        syncOverlayAudioUi(false);
        applyAudioVolume(false);
    }

    function setOverlayEnabled(enabled, persist = true) {
        overlaysEnabled = enabled;
        shell.classList.toggle("overlays-hidden", !enabled);
        if (overlayToggleButton) {
            overlayToggleButton.textContent = enabled ? "Hide overlay" : "Show overlay";
            overlayToggleButton.setAttribute("aria-pressed", String(!enabled));
        }
        if (persist) localStorage.removeItem(overlayStorageKey);
        if (!enabled) {
            setLayoutEditMode(false);
            releaseAllTouchButtons();
        }
        wakePlayerChrome(enabled ? 2400 : 0);
    }

    function toggleOverlay() {
        const next = playerHelpers?.nextOverlayEnabledState?.(overlaysEnabled) ?? !overlaysEnabled;
        setOverlayEnabled(next);
        setStatus(next ? "Overlay visible." : "Overlay hidden for kiosk mode.", "good");
        showTransientPlayerPrompt(next ? "Overlay on" : "Overlay off");
    }

    function waitForIceGatheringComplete(peer) {
        if (peer.iceGatheringState === "complete") return Promise.resolve();
        // If we already have host candidates (they're collected synchronously),
        // don't wait for TURN/STUN candidates — return immediately.
        var sdp = (peer.localDescription && peer.localDescription.sdp) || "";
        if (sdp.indexOf("a=candidate") !== -1) return Promise.resolve();
        return new Promise(function (resolve) {
            const timeout = window.setTimeout(function () {
                peer.removeEventListener("icecandidate", onCandidate);
                peer.removeEventListener("icegatheringstatechange", onState);
                resolve();
            }, 500);
            const onCandidate = function (event) {
                if (event.candidate) {
                    // Got our first ICE candidate (typically host) — good enough to start
                    window.clearTimeout(timeout);
                    peer.removeEventListener("icecandidate", onCandidate);
                    peer.removeEventListener("icegatheringstatechange", onState);
                    resolve();
                }
            };
            const onState = function () {
                if (peer.iceGatheringState === "complete") {
                    window.clearTimeout(timeout);
                    peer.removeEventListener("icecandidate", onCandidate);
                    peer.removeEventListener("icegatheringstatechange", onState);
                    resolve();
                }
            };
            peer.addEventListener("icecandidate", onCandidate);
            peer.addEventListener("icegatheringstatechange", onState);
        });
    }

    function enterCssFullscreenFallback() {
        shell.classList.add("is-ios-fullscreen");
        syncFullscreenUi();
        setStatus("Fullscreen view. Double tap the stream again to exit.", "good");
    }

    async function exitCssFullscreenFallback() {
        shell.classList.remove("is-ios-fullscreen");
        syncFullscreenUi();
        setStatus("Exited fullscreen view.", "good");
    }

    async function toggleFullscreen() {
        try {
            if (!isFullscreenActive()) {
                if (shell.requestFullscreen) {
                    await shell.requestFullscreen({ navigationUI: "hide" });
                } else if (shell.webkitRequestFullscreen) {
                    shell.webkitRequestFullscreen();
                } else {
                    enterCssFullscreenFallback();
                    return;
                }
                if (screen.orientation?.lock) {
                    const currentType = screen.orientation.type;
                    if (currentType.startsWith("landscape")) {
                        try { await screen.orientation.lock("landscape"); } catch { }
                    }
                }
                setStatus("Fullscreen. Double tap the stream or use your browser gesture to exit.");
            } else {
                if (shell.classList.contains("is-ios-fullscreen")) {
                    await exitCssFullscreenFallback();
                } else if (document.exitFullscreen) {
                    await document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                }
            }
        } catch {
            if (!isFullscreenActive()) {
                enterCssFullscreenFallback();
                return;
            }
            setStatus("Fullscreen request was blocked by the browser.");
        }
    }

    function handleDoubleTap(ev) {
        // Let actual virtual gamepad button taps pass through without toggling fullscreen.
        if (ev.target?.closest?.(".touch-btn, .player-overlay-action")) return;
        const now = Date.now();
        if (now - lastTapAt <= 320) {
            ev.preventDefault();
            lastTapAt = 0;
            toggleFullscreen();
            return;
        }
        lastTapAt = now;
    }

    function setTouchControl(name, button, pressed) {
        if (pressed) {
            touchControls.add(name);
            button?.classList.add("is-pressed");
        } else {
            touchControls.delete(name);
            button?.classList.remove("is-pressed");
        }
    }

    function setTouchButton(button, pressed) {
        const name = button?.dataset?.button;
        if (!name) return;
        setTouchControl(name, button, pressed);
        sendInputImmediately();
    }

    function isDpadButton(button) {
        return dpadButtonNames.has(button?.dataset?.button || "");
    }

    function setDpadButtons(buttonNames) {
        const pressed = new Set(buttonNames);
        for (const button of touchButtons) {
            const name = button.dataset.button;
            if (!dpadButtonNames.has(name)) continue;
            setTouchControl(name, button, pressed.has(name));
        }
        sendInputImmediately();
    }

    function updateDpadPointer(ev) {
        if (!activeDpadPointer || ev.pointerId !== activeDpadPointer.pointerId) return;
        ev.preventDefault();
        const rect = activeDpadPointer.cluster.getBoundingClientRect();
        const buttons = inputHelpers?.resolveDpadButtonsFromPoint?.(rect, ev.clientX, ev.clientY) || [];
        setDpadButtons(buttons);
    }

    function beginDpadPointer(ev, cluster) {
        if (layoutEditMode) return false;
        ev.preventDefault();
        activeDpadPointer = { pointerId: ev.pointerId, cluster };
        cluster.setPointerCapture?.(ev.pointerId);
        updateDpadPointer(ev);
        return true;
    }

    function endDpadPointer(ev) {
        if (!activeDpadPointer || ev.pointerId !== activeDpadPointer.pointerId) return;
        activeDpadPointer = null;
        setDpadButtons([]);
    }

    function releaseAllTouchButtons() {
        activeDpadPointer = null;
        touchControls.clear();
        for (const button of touchButtons) {
            button.classList.remove("is-pressed");
        }
        sendInputImmediately();
    }

    function setLayoutEditMode(enabled) {
        layoutEditMode = enabled;
        shell.classList.toggle("layout-editing", enabled);
        releaseAllTouchButtons();
        layoutLockButton.textContent = enabled ? "Save layout" : "Unlock layout";
        layoutLockButton.setAttribute("aria-label", enabled ? "Save control layout" : "Unlock control layout");
        setStatus(enabled ? "Layout unlocked. Drag the controls, then tap Save layout." : "Layout locked.");
        wakePlayerChrome(enabled ? 10_000 : 2400);
        showTransientPlayerPrompt(enabled ? "Layout edit mode" : "Layout locked");
    }

    function applySavedLayout() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(layoutStorageKey) || "null"); } catch { }
        if (!saved || typeof saved !== "object") return;
        for (const control of draggableControls) {
            const item = saved[control.dataset.controlGroup];
            if (!item || typeof item.left !== "number" || typeof item.top !== "number") continue;
            positionControl(control, item.left, item.top);
        }
    }

    function saveLayout() {
        const layout = {};
        for (const control of draggableControls) {
            const rect = control.getBoundingClientRect();
            const container = control.offsetParent;
            const containerRect = container ? container.getBoundingClientRect() : shell.getBoundingClientRect();
            layout[control.dataset.controlGroup] = {
                left: ((rect.left - containerRect.left) / containerRect.width) * 100,
                top: ((rect.top - containerRect.top) / containerRect.height) * 100
            };
        }
        localStorage.setItem(layoutStorageKey, JSON.stringify(layout));
        setLayoutEditMode(false);
        setStatus("Control layout saved on this device.");
        showTransientPlayerEvent("Custom control layout saved on this device.", "good", 2400, "Controls updated");
    }

    function resetLayout() {
        localStorage.removeItem(layoutStorageKey);
        releaseAllTouchButtons();
        for (const control of draggableControls) {
            control.style.left = "";
            control.style.top = "";
            control.style.right = "";
            control.style.bottom = "";
            control.style.transform = "";
        }
        setLayoutEditMode(false);
        setStatus("Control layout reset to defaults.", "good");
        showTransientPlayerPrompt("Controls reset");
    }

    function positionControl(control, leftPct, topPct) {
        const container = control.offsetParent;
        const containerRect = container ? container.getBoundingClientRect() : shell.getBoundingClientRect();
        const shellRect = shell.getBoundingClientRect();
        const rect = control.getBoundingClientRect();
        // Clamp against shell bounds so controls can't be dragged entirely off-screen,
        // but convert to container-relative percentages since that's the coordinate
        // space left/top percentages resolve against.
        const maxLeftShell = Math.max(0, 100 - (rect.width / shellRect.width) * 100);
        const maxTopShell = Math.max(0, 100 - (rect.height / shellRect.height) * 100);
        const scaleX = shellRect.width / containerRect.width;
        const scaleY = shellRect.height / containerRect.height;
        const maxLeft = maxLeftShell * scaleX;
        const maxTop = maxTopShell * scaleY;
        const left = Math.min(Math.max(leftPct, 0), maxLeft);
        const top = Math.min(Math.max(topPct, 0), maxTop);
        control.style.left = `${left}%`;
        control.style.top = `${top}%`;
        control.style.right = "auto";
        control.style.bottom = "auto";
        control.style.transform = "none";
    }

    function beginLayoutDrag(ev, control) {
        if (!layoutEditMode) return false;
        ev.preventDefault();
        ev.stopPropagation();
        releaseAllTouchButtons();
        const shellRect = shell.getBoundingClientRect();
        const rect = control.getBoundingClientRect();
        const container = control.offsetParent;
        const containerRect = container ? container.getBoundingClientRect() : shellRect;
        activeDrag = {
            control,
            pointerId: ev.pointerId,
            offsetX: ev.clientX - rect.left,
            offsetY: ev.clientY - rect.top,
            shellRect,
            containerRect
        };
        control.classList.add("is-dragging");
        control.setPointerCapture?.(ev.pointerId);
        return true;
    }

    function updateLayoutDrag(ev) {
        if (!activeDrag || ev.pointerId !== activeDrag.pointerId) return;
        ev.preventDefault();
        const leftPct = ((ev.clientX - activeDrag.containerRect.left - activeDrag.offsetX) / activeDrag.containerRect.width) * 100;
        const topPct = ((ev.clientY - activeDrag.containerRect.top - activeDrag.offsetY) / activeDrag.containerRect.height) * 100;
        positionControl(activeDrag.control, leftPct, topPct);
    }

    function endLayoutDrag(ev) {
        if (!activeDrag || ev.pointerId !== activeDrag.pointerId) return;
        activeDrag.control.classList.remove("is-dragging");
        activeDrag = null;
    }

    for (const control of draggableControls) {
        control.addEventListener("pointerdown", ev => beginLayoutDrag(ev, control));
        control.addEventListener("pointermove", updateLayoutDrag);
        control.addEventListener("pointerup", endLayoutDrag);
        control.addEventListener("pointercancel", endLayoutDrag);
        control.addEventListener("lostpointercapture", endLayoutDrag);
    }

    for (const cluster of dpadClusters) {
        cluster.addEventListener("pointerdown", ev => beginDpadPointer(ev, cluster));
        cluster.addEventListener("pointermove", updateDpadPointer);
        cluster.addEventListener("pointerup", endDpadPointer);
        cluster.addEventListener("pointercancel", endDpadPointer);
        cluster.addEventListener("lostpointercapture", endDpadPointer);
    }

    restoreGamepadSelection();
    applySavedLayout();

    for (const button of touchButtons) {
        button.addEventListener("pointerdown", ev => {
            if (layoutEditMode) return;
            if (isDpadButton(button)) return;
            ev.preventDefault();
            button.setPointerCapture?.(ev.pointerId);
            setTouchButton(button, true);
        });
        button.addEventListener("pointerup", ev => {
            if (isDpadButton(button)) return;
            ev.preventDefault();
            setTouchButton(button, false);
        });
        button.addEventListener("pointercancel", () => {
            if (!isDpadButton(button)) setTouchButton(button, false);
        });
        button.addEventListener("lostpointercapture", () => {
            if (!isDpadButton(button)) setTouchButton(button, false);
        });
        button.addEventListener("contextmenu", ev => ev.preventDefault());
    }

    for (const button of commandButtons) {
        button.addEventListener("pointerdown", ev => {
            if (layoutEditMode) return;
            ev.preventDefault();
            sendCommand(button.dataset.command, button);
        });
        button.addEventListener("contextmenu", ev => ev.preventDefault());
    }

    function handleFullscreenChange() {
        syncFullscreenUi();
        if (!isFullscreenActive() && screen.orientation?.unlock) {
            try { screen.orientation.unlock(); } catch { }
        }
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

    window.addEventListener("blur", releaseAllTouchButtons);
    window.addEventListener("resize", fitCanvasToShell);
    window.addEventListener("pointermove", () => wakePlayerChrome());
    window.addEventListener("focus", () => wakePlayerChrome(2400));
    window.addEventListener("mousemove", () => wakePlayerChrome());
    window.addEventListener("pointerdown", ev => {
        primePreconnectedGamepads(ev);
        startPlayback();
    }, { capture: true });
    window.addEventListener("keydown", ev => {
        primePreconnectedGamepads(ev);
        startPlayback();
    }, { capture: true });
    shell.addEventListener("pointerdown", ev => {
        focusPlayerSurface();
        if (!ev.target?.closest?.("#touch-gamepad")) {
            wakePlayerChrome(2800);
        }
    });
    shell.addEventListener("touchstart", ev => {
        focusPlayerSurface();
        if (!ev.target?.closest?.("#touch-gamepad")) {
            wakePlayerChrome(2800);
        }
    }, { passive: true });
    window.addEventListener("gamepadconnected", event => {
        primePreconnectedGamepads(event);
        updatePadChip();
        updatePadTestPanel();
    });
    window.addEventListener("gamepaddisconnected", event => {
        forgetGamepad(event.gamepad);
        if (selectedGamepadIndex === event.gamepad?.index) {
            selectedGamepadIndex = playerHelpers?.chooseInitialGamepadIndex?.(connectedGamepads(), null, preferredGamepadIndex) ?? null;
            syncGamepadSelectionOptions();
        }
        updatePadChip();
        updatePadTestPanel();
    });
    window.addEventListener("error", event => {
        const message = event?.message || "Unknown window error.";
        appendPlayerLog("bad", "Window error", message);
    });
    window.addEventListener("unhandledrejection", event => {
        const reason = event?.reason instanceof Error
            ? event.reason.message
            : String(event?.reason ?? "Unhandled promise rejection.");
        appendPlayerLog("bad", "Unhandled rejection", reason);
    });
    window.addEventListener("message", event => {
        if (event.origin !== window.location.origin) {
            return;
        }

        const payload = event.data;
        if (!payload || payload.type !== "games-vault:player-log") {
            return;
        }

        const entries = Array.isArray(payload.entries) ? payload.entries : [];
        for (const entry of entries) {
            if (!entry || typeof entry !== "object") {
                continue;
            }

            appendPlayerLog(
                typeof entry.level === "string" ? entry.level : "warn",
                typeof entry.title === "string" ? entry.title : "Battery saves",
                typeof entry.message === "string" ? entry.message : JSON.stringify(entry));
        }
    });
    shell.addEventListener("touchend", handleDoubleTap, { passive: false });
    shell.addEventListener("dblclick", ev => {
        if (ev.target?.closest?.(".touch-btn, .player-overlay-action")) return;
        ev.preventDefault();
        toggleFullscreen();
    });

    window.addEventListener("keydown", ev => {
        if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement || ev.target?.isContentEditable) return;
        if (!ev.repeat && ev.code === "KeyC") {
            ev.preventDefault();
            sendCommand("insert_coin");
            return;
        }
        if (!ev.repeat && ev.code === "KeyR") {
            ev.preventDefault();
            sendCommand("reset");
            return;
        }
        const wasPressed = keys.has(ev.code);
        keys.add(ev.code);
        if (ev.code.startsWith("Arrow")) ev.preventDefault();
        if (!wasPressed) sendInputImmediately();
    });
    window.addEventListener("keyup", ev => {
        const wasPressed = keys.delete(ev.code);
        if (ev.code.startsWith("Arrow")) ev.preventDefault();
        if (wasPressed) sendInputImmediately();
    });
    rtcTrackVideo?.addEventListener("loadedmetadata", () => {
        fitRtcTrackVideoToShell();
        scheduleRtcTrackFrameCallbacks();
    });
    rtcTrackVideo?.addEventListener("playing", () => {
        fitRtcTrackVideoToShell();
        scheduleRtcTrackFrameCallbacks();
    });

    videoTransportSelect?.addEventListener("change", () => {
        selectedVideoTransport = playerHelpers?.normalizeVideoTransportPreference?.(videoTransportSelect.value) ?? "webrtc-track";
        reconnectForVideoPreferenceChange(`Video transport set to ${selectedVideoTransport}. Reconnecting…`);
    });
    videoCompressionSelect?.addEventListener("change", () => {
        selectedVideoCompression = playerHelpers?.normalizeVideoCompressionPreference?.(videoCompressionSelect.value) ?? "balanced";
        reconnectForVideoPreferenceChange(`Video compression set to ${selectedVideoCompression}. Reconnecting…`);
    });

    connectButton?.addEventListener("click", () => {
        clearReconnect();
        wakePlayerChrome(3200);
        showTransientPlayerPrompt("Reconnecting…", 1700);
        startPlayback();
        connect();
    });
    viewWindowedButton?.addEventListener("click", () => {
        if (isFullscreenActive()) {
            toggleFullscreen();
        }
        applyViewMode("windowed");
        setStatus("Windowed view enabled.", "good");
        wakePlayerChrome(2600);
        showTransientPlayerPrompt("Windowed view");
    });
    viewTheaterButton?.addEventListener("click", () => {
        if (isFullscreenActive()) {
            toggleFullscreen();
        }
        applyViewMode("theater");
        setStatus("Theater view enabled.", "good");
        wakePlayerChrome(2600);
        showTransientPlayerPrompt("Theater view");
    });
    audioButton?.addEventListener("click", toggleAudio);
    audioOverlayButton.addEventListener("click", ev => {
        if (layoutEditMode) {
            ev.preventDefault();
            return;
        }
        toggleAudio();
    });
    if (volumeSlider instanceof HTMLInputElement) {
        volumeSlider.addEventListener("input", () => {
            audioVolume = Number.parseFloat(volumeSlider.value) / 100;
            applyAudioVolume();
            wakePlayerChrome(2600);
        });
    } else if (volumeSlider) {
        volumeSlider.addEventListener("pointerdown", ev => {
            ev.preventDefault();
            volumeSlider.setPointerCapture?.(ev.pointerId);
            setVolumeFromPoint(ev.clientX);
        });
        volumeSlider.addEventListener("pointermove", ev => {
            if (!ev.buttons) {
                return;
            }

            ev.preventDefault();
            setVolumeFromPoint(ev.clientX);
        });
        volumeSlider.addEventListener("keydown", ev => {
            if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp", "Home", "End"].includes(ev.key)) {
                return;
            }

            ev.preventDefault();
            setVolumeFromKey(ev.key);
        });
    }
    overlayToggleButton?.addEventListener("click", toggleOverlay);
    loggingToggleButton?.addEventListener("click", toggleLogOverlay);
    playerLogClearButton?.addEventListener("click", () => {
        clearPlayerLog();
    });
    saveStateSlotSelect?.addEventListener("change", () => {
        setSaveStateSlot(saveStateSlotSelect.value, true);
        setStatus(`Save state slot ${saveStateSlot} selected.`, "good");
        wakePlayerChrome(2400);
    });
    saveStateSaveButton?.addEventListener("click", ev => {
        ev.preventDefault();
        sendStateCommand("save_state", saveStateSaveButton);
    });
    saveStateLoadButton?.addEventListener("click", ev => {
        ev.preventDefault();
        sendStateCommand("load_state", saveStateLoadButton);
    });
    layoutLockButton.addEventListener("click", () => {
        if (layoutEditMode) saveLayout();
        else setLayoutEditMode(true);
    });
    layoutResetButton?.addEventListener("click", ev => {
        ev.preventDefault();
        resetLayout();
    });
    fullscreenButton.addEventListener("click", () => {
        wakePlayerChrome(2600);
        showTransientPlayerPrompt(isFullscreenActive() ? "Leaving full screen" : "Full screen");
        toggleFullscreen();
    });
    touchToggleButton?.addEventListener("click", () => {
        touchGamepad?.classList.toggle("force-visible");
        touchGamepad?.classList.toggle("is-visible");
        releaseAllTouchButtons();
    });
    gamepadSelect?.addEventListener("change", () => {
        selectedGamepadIndex = gamepadSelect.value === "" ? null : Number.parseInt(gamepadSelect.value, 10);
        if (selectedGamepadIndex === null || Number.isNaN(selectedGamepadIndex)) {
            selectedGamepadIndex = null;
            localStorage.removeItem(gamepadStorageKey);
        } else {
            localStorage.setItem(gamepadStorageKey, String(selectedGamepadIndex));
        }
        updatePadChip();
        updatePadTestPanel();
        setStatus(selectedGamepadIndex === null ? "Using keyboard plus first hardware gamepad." : `Using hardware gamepad ${selectedGamepadIndex + 1}.`, "good");
    });
    padTestToggle?.addEventListener("click", () => {
        if (padTestPanel?.classList.contains("d-none")) startPadTest();
        else hidePadTest();
    });
    const leaveSeatForm = document.getElementById("leave-seat-form");
    leaveSeatForm?.addEventListener("submit", () => {
        stopSeatKeepAlive();
        closeSockets();
    });
    window.addEventListener("beforeunload", () => {
        if (!sessionId || isSpectator) return;
        const formUrl = leaveSeatForm?.getAttribute("action") ?? "";
        if (!formUrl) return;
        const csrfToken = document.querySelector('input[name="__RequestVerificationToken"]')?.value ?? "";
        const body = new URLSearchParams({ sessionId });
        try { fetch(formUrl, { method: "POST", headers: { "X-CSRF-TOKEN": csrfToken }, body, keepalive: true, credentials: "same-origin" }).catch(() => {}); } catch {}
    });
    syncVideoPreferenceControls();
    applyViewMode(preferredViewMode, false);
    applyAudioVolume(false);
    if (playerLogList) {
        clearPlayerLog();
    }
    setLogOverlayEnabled(logOverlayEnabled, false);
    setSaveStateSlot(saveStateSlot, false);
    appendBatterySaveDiagnostics(bootstrapBatterySaveDiagnostics);
    connect();
    setOverlayEnabled(true, false);
    setAudioDisabledUi();
    startGamepadPolling();
    updatePadChip();

    // Keyboard reference overlay
    const keyboardOverlay = document.getElementById("nosebleed-keyboard-overlay");
    const keyboardHelpBtn = document.getElementById("nosebleed-keyboard-help");
    const keyboardOverlayClose = document.getElementById("nosebleed-keyboard-overlay-close");
    const keyboardMappingEl = document.getElementById("nosebleed-keyboard-mapping");

    const KEYBOARD_MAPS = {
        "Nintendo - Nintendo 64": [
            { s: "Movement", k: "Arrow keys", l: "D-Pad" },
            { s: "Actions", k: "Z", l: "A" },
            { k: "X", l: "B" },
            { k: "A", l: "L shoulder" },
            { k: "S", l: "R shoulder" },
            { k: "D", l: "Z trigger" },
            { k: "Enter", l: "Start" },
            { s: "C-Buttons", k: "I", l: "C-Up" },
            { k: "K", l: "C-Down" },
            { k: "J", l: "C-Left" },
            { k: "L", l: "C-Right" },
            { s: "Commands", k: "C", l: "Insert Coin" },
            { k: "R", l: "Reset" },
        ],
        "default": [
            { s: "Movement", k: "Arrow keys", l: "D-Pad" },
            { s: "Actions", k: "Z", l: "A" },
            { k: "X", l: "B" },
            { k: "Enter", l: "Start" },
            { k: "Shift", l: "Select" },
            { s: "Commands", k: "C", l: "Insert Coin" },
            { k: "R", l: "Reset" },
        ],
    };

    function buildKeyboardMapping(systemName) {
        const map = KEYBOARD_MAPS[systemName] || KEYBOARD_MAPS["default"];
        let html = "";
        let lastSection = null;
        for (const row of map) {
            if (row.s && row.s !== lastSection) {
                html += `<div class="km-section">${row.s}</div>`;
                lastSection = row.s;
            }
            html += `<span class="km-key">${row.k}</span><span class="km-label">${row.l}</span>`;
        }
        keyboardMappingEl.innerHTML = html;
    }

    function showKeyboardOverlay() {
        if (!keyboardOverlay) return;
        keyboardOverlay.removeAttribute("hidden");
    }

    function hideKeyboardOverlay() {
        if (!keyboardOverlay) return;
        keyboardOverlay.setAttribute("hidden", "");
    }

    const systemName = document.querySelector("meta[name=\"game-system\"]")?.content
        || document.querySelector("[data-game-system]")?.dataset.gameSystem
        || "";
    buildKeyboardMapping(systemName);
    if (rtcTrackVideo && systemName) {
        const ar = SYSTEM_ASPECT_RATIOS[systemName] || DEFAULT_ASPECT_RATIO;
        rtcTrackVideo.style.aspectRatio = ar;
    }

    keyboardHelpBtn?.addEventListener("click", showKeyboardOverlay);
    keyboardOverlayClose?.addEventListener("click", hideKeyboardOverlay);
    keyboardOverlay?.querySelector(".keyboard-overlay-backdrop")?.addEventListener("click", hideKeyboardOverlay);
    window.addEventListener("keydown", ev => {
        if (ev.key === "Escape" && !keyboardOverlay?.hasAttribute("hidden")) {
            hideKeyboardOverlay();
        }
    });
})();
