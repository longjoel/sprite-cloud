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
    const statusEl = document.getElementById("nosebleed-status");
    const shell = document.getElementById("server-player-shell");
    const canvas = document.getElementById("nosebleed-screen");
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    const connectButton = document.getElementById("nosebleed-connect");
    const audioButton = document.getElementById("nosebleed-audio");
    const audioOverlayButton = document.getElementById("nosebleed-audio-overlay");
    const layoutLockButton = document.getElementById("nosebleed-layout-lock");
    const layoutResetButton = document.getElementById("nosebleed-layout-reset");
    const fullscreenButton = document.getElementById("nosebleed-fullscreen");
    const touchToggleButton = document.getElementById("nosebleed-touch-toggle");
    const gamepadSelect = document.getElementById("nosebleed-gamepad-select");
    const padTestToggle = document.getElementById("nosebleed-pad-test-toggle");
    const padTestPanel = document.getElementById("nosebleed-pad-test-panel");
    const padTestSummary = document.getElementById("nosebleed-pad-test-summary");
    const padTestButtons = document.getElementById("nosebleed-pad-test-buttons");
    const padTestAxes = document.getElementById("nosebleed-pad-test-axes");
    const touchGamepad = document.getElementById("touch-gamepad");
    const touchButtons = Array.from(document.querySelectorAll(".touch-btn[data-button]"));
    const draggableControls = Array.from(document.querySelectorAll("[data-control-group]"));
    const chips = {
        video: document.getElementById("nosebleed-video-chip"),
        input: document.getElementById("nosebleed-input-chip"),
        pad: document.getElementById("nosebleed-pad-chip"),
        fps: document.getElementById("nosebleed-fps-chip"),
        status: document.getElementById("nosebleed-status-chip")
    };
    const layoutStorageKey = `games-vault:nosebleed-control-layout:${touchLayoutName}`;
    const gamepadStorageKey = "games-vault:nosebleed-gamepad-index";
    const touchControls = new Set();
    let layoutEditMode = false;
    let activeDrag = null;
    let lastTapAt = 0;
    let videoWs = null;
    let inputWs = null;
    let audioWs = null;
    let inputSeq = 0;
    let inputTimer = 0;
    let keepAliveTimer = 0;
    let fpsTimer = 0;
    let framesThisSecond = 0;
    let pendingVideoFrame = null;
    let videoFrameScheduled = false;
    let videoFramesReceived = 0;
    let videoFramesDropped = 0;
    let videoRenderMs = 0;
    let selectedGamepadIndex = null;
    let padTestTimer = 0;
    let audioCtx = null;
    let audioStartTime = 0;
    const keys = new Set();

    function setStatus(text, tone = "warn") {
        statusEl.textContent = text;
        updateChip(chips.status, text.replace(/[.…]+$/u, ""), tone);
    }

    function updateChip(chip, label, tone = "neutral") {
        if (!chip) return;
        const labelEl = chip.querySelector(".chip-label");
        if (labelEl) labelEl.textContent = label;
        chip.classList.toggle("is-good", tone === "good");
        chip.classList.toggle("is-warn", tone === "warn");
        chip.classList.toggle("is-bad", tone === "bad");
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

    function connectedGamepads() {
        return Array.from(navigator.getGamepads?.() || []).filter(Boolean);
    }

    function syncGamepadSelectionOptions() {
        if (!gamepadSelect) return;
        const pads = connectedGamepads();
        const currentValue = selectedGamepadIndex === null ? "" : String(selectedGamepadIndex);
        gamepadSelect.replaceChildren(new Option("Keyboard / first gamepad", ""));
        for (const pad of pads) {
            const name = pad.id ? pad.id.split("(")[0].trim() : `Gamepad ${pad.index + 1}`;
            gamepadSelect.appendChild(new Option(`${pad.index + 1}: ${name}`, String(pad.index)));
        }
        if ([...gamepadSelect.options].some(option => option.value === currentValue)) {
            gamepadSelect.value = currentValue;
        } else {
            selectedGamepadIndex = null;
            gamepadSelect.value = "";
            localStorage.removeItem(gamepadStorageKey);
        }
    }

    function getActiveGamepad() {
        const pads = navigator.getGamepads?.() || [];
        if (selectedGamepadIndex !== null) return pads[selectedGamepadIndex] || null;
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
        syncGamepadSelectionOptions();
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

    function withToken(path) {
        const url = new URL(path, baseUrl);
        if (token) url.searchParams.set("token", token);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.toString();
    }

    function connect() {
        closeSockets();
        setStatus("Connecting…");
        updateChip(chips.video, "Video connecting", "warn");
        updateChip(chips.input, isSpectator ? "Spectator" : "Input connecting", "warn");
        startHudTimers();
        videoWs = new WebSocket(withToken("/ws/video"));
        videoWs.binaryType = "arraybuffer";
        videoWs.onopen = () => {
            updateChip(chips.video, "Video live", "good");
            setStatus("Video connected.", "good");
        };
        videoWs.onmessage = ev => queueVideoFrame(ev.data);
        videoWs.onerror = () => {
            updateChip(chips.video, "Video error", "bad");
            setStatus("Video socket error.", "bad");
        };
        videoWs.onclose = () => {
            updateChip(chips.video, "Video offline", "bad");
            setStatus("Video disconnected.", "bad");
        };

        if (!isSpectator && assignedPort !== null) {
            inputWs = new WebSocket(withToken("/ws/input"));
            inputWs.onopen = () => {
                updateChip(chips.input, `P${assignedPort + 1} input`, "good");
                setStatus(`Connected as Player ${assignedPort + 1}. Sending input.`, "good");
                startInputLoop();
            };
            inputWs.onerror = () => {
                updateChip(chips.input, "Input error", "bad");
                setStatus("Input socket error.", "bad");
            };
            inputWs.onclose = () => {
                updateChip(chips.input, "Input offline", "bad");
                stopInputLoop();
            };
        } else {
            updateChip(chips.input, "Spectator", "warn");
            setStatus("Connected as spectator. Input disabled.", "warn");
        }
        startSeatKeepAlive();
    }

    function closeSockets() {
        stopInputLoop();
        stopSeatKeepAlive();
        stopHudTimers();
        updateChip(chips.video, "Video idle", "warn");
        updateChip(chips.input, isSpectator ? "Spectator" : "Input idle", "warn");
        updateChip(chips.fps, "0 fps", "neutral");
        framesThisSecond = 0;
        videoFramesReceived = 0;
        videoFramesDropped = 0;
        videoRenderMs = 0;
        pendingVideoFrame = null;
        videoFrameScheduled = false;
        for (const ws of [videoWs, inputWs, audioWs]) {
            try { ws?.close(); } catch { }
        }
        videoWs = inputWs = audioWs = null;
    }

    function queueVideoFrame(buffer) {
        videoFramesReceived += 1;
        if (pendingVideoFrame) videoFramesDropped += 1;
        pendingVideoFrame = buffer;
        if (videoFrameScheduled) return;
        videoFrameScheduled = true;
        window.requestAnimationFrame(() => {
            videoFrameScheduled = false;
            const latest = pendingVideoFrame;
            pendingVideoFrame = null;
            if (latest) drawFrame(latest);
        });
    }

    function drawFrame(buffer) {
        const renderStartedAt = performance.now();
        const data = new DataView(buffer);
        if (data.byteLength < 33 || magic(data, 0) !== "NBF0") return;
        const width = data.getUint32(20, true);
        const height = data.getUint32(24, true);
        const pitch = data.getUint32(28, true);
        const pixelFormat = data.getUint8(32);
        const payloadLen = data.getUint32(33, true);
        const payloadOffset = 37;
        if (data.byteLength < payloadOffset + payloadLen) return;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const src = new Uint8Array(buffer, payloadOffset, payloadLen);
        const image = ctx.createImageData(width, height);
        const out = image.data;
        if (pixelFormat === 0) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const si = y * pitch + x * 4;
                    const di = (y * width + x) * 4;
                    out[di] = src[si + 2];
                    out[di + 1] = src[si + 1];
                    out[di + 2] = src[si];
                    out[di + 3] = 255;
                }
            }
        } else if (pixelFormat === 1) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const si = y * pitch + x * 2;
                    const v = src[si] | (src[si + 1] << 8);
                    const di = (y * width + x) * 4;
                    out[di] = ((v >> 11) & 0x1f) * 255 / 31;
                    out[di + 1] = ((v >> 5) & 0x3f) * 255 / 63;
                    out[di + 2] = (v & 0x1f) * 255 / 31;
                    out[di + 3] = 255;
                }
            }
        } else {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const si = y * pitch + x * 2;
                    const v = src[si] | (src[si + 1] << 8);
                    const di = (y * width + x) * 4;
                    out[di] = ((v >> 10) & 0x1f) * 255 / 31;
                    out[di + 1] = ((v >> 5) & 0x1f) * 255 / 31;
                    out[di + 2] = (v & 0x1f) * 255 / 31;
                    out[di + 3] = 255;
                }
            }
        }
        framesThisSecond += 1;
        ctx.putImageData(image, 0, 0);
        videoRenderMs = performance.now() - renderStartedAt;
    }

    function startInputLoop() {
        stopInputLoop();
        inputTimer = window.setInterval(sendInput, 16);
    }
    function stopInputLoop() {
        if (inputTimer) window.clearInterval(inputTimer);
        inputTimer = 0;
    }

    function sendInputImmediately() {
        try { sendInput(); } catch { }
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
            const response = await fetch(keepAliveUrl, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
            a: keys.has("KeyZ") || touchControls.has("a") || !!pad?.buttons[0]?.pressed,
            b: keys.has("KeyX") || touchControls.has("b") || !!pad?.buttons[1]?.pressed,
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
        audioCtx ??= new AudioContext({ latencyHint: "interactive" });
        await audioCtx.resume();
        audioStartTime = Math.max(audioCtx.currentTime, audioStartTime);
        if (audioWs && audioWs.readyState === WebSocket.OPEN) {
            setAudioEnabledUi();
            return;
        }
        audioWs = new WebSocket(withToken("/ws/audio"));
        audioWs.binaryType = "arraybuffer";
        audioWs.onopen = () => {
            setAudioEnabledUi();
            setStatus("Audio connected.");
        };
        audioWs.onmessage = ev => playAudio(ev.data);
    }

    function setAudioEnabledUi() {
        audioButton.textContent = "Audio enabled";
        audioOverlayButton.textContent = "Sound on";
        audioOverlayButton.classList.add("is-on");
        audioOverlayButton.setAttribute("aria-label", "Sound enabled");
    }

    function playAudio(buffer) {
        if (!audioCtx) return;
        const data = new DataView(buffer);
        if (data.byteLength < 30 || magic(data, 0) !== "NBA0") return;
        const sampleRate = data.getUint32(20, true);
        const channels = data.getUint8(24);
        const frameCount = data.getUint32(26, true);
        const payloadLen = data.getUint32(30, true);
        const offset = 34;
        if (channels !== 2 || data.byteLength < offset + payloadLen) return;
        const audioBuffer = audioCtx.createBuffer(2, frameCount, sampleRate);
        const left = audioBuffer.getChannelData(0);
        const right = audioBuffer.getChannelData(1);
        for (let i = 0; i < frameCount; i++) {
            left[i] = data.getInt16(offset + i * 4, true) / 32768;
            right[i] = data.getInt16(offset + i * 4 + 2, true) / 32768;
        }
        const src = audioCtx.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(audioCtx.destination);
        audioStartTime = Math.max(audioCtx.currentTime, audioStartTime);
        src.start(audioStartTime);
        audioStartTime += frameCount / sampleRate;
    }

    function magic(view, offset) {
        return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    }

    async function toggleFullscreen() {
        try {
            if (!document.fullscreenElement) {
                await shell.requestFullscreen({ navigationUI: "hide" });
                if (screen.orientation?.lock) {
                    try { await screen.orientation.lock("landscape"); } catch { }
                }
                setStatus("Fullscreen. Double tap the stream or use your browser gesture to exit.");
            } else {
                await document.exitFullscreen();
            }
        } catch {
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

    function setTouchButton(button, pressed) {
        const name = button?.dataset?.button;
        if (!name) return;
        if (pressed) {
            touchControls.add(name);
            button.classList.add("is-pressed");
        } else {
            touchControls.delete(name);
            button.classList.remove("is-pressed");
        }
        sendInputImmediately();
    }

    function releaseAllTouchButtons() {
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
        const shellRect = shell.getBoundingClientRect();
        const layout = {};
        for (const control of draggableControls) {
            const rect = control.getBoundingClientRect();
            layout[control.dataset.controlGroup] = {
                left: ((rect.left - shellRect.left) / shellRect.width) * 100,
                top: ((rect.top - shellRect.top) / shellRect.height) * 100
            };
        }
        localStorage.setItem(layoutStorageKey, JSON.stringify(layout));
        setLayoutEditMode(false);
        setStatus("Control layout saved on this device.");
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
    }

    function positionControl(control, leftPct, topPct) {
        const shellRect = shell.getBoundingClientRect();
        const rect = control.getBoundingClientRect();
        const maxLeft = Math.max(0, 100 - (rect.width / shellRect.width) * 100);
        const maxTop = Math.max(0, 100 - (rect.height / shellRect.height) * 100);
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
        activeDrag = {
            control,
            pointerId: ev.pointerId,
            offsetX: ev.clientX - rect.left,
            offsetY: ev.clientY - rect.top,
            shellRect
        };
        control.classList.add("is-dragging");
        control.setPointerCapture?.(ev.pointerId);
        return true;
    }

    function updateLayoutDrag(ev) {
        if (!activeDrag || ev.pointerId !== activeDrag.pointerId) return;
        ev.preventDefault();
        const rect = activeDrag.control.getBoundingClientRect();
        const leftPct = ((ev.clientX - activeDrag.shellRect.left - activeDrag.offsetX) / activeDrag.shellRect.width) * 100;
        const topPct = ((ev.clientY - activeDrag.shellRect.top - activeDrag.offsetY) / activeDrag.shellRect.height) * 100;
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

    restoreGamepadSelection();
    applySavedLayout();

    for (const button of touchButtons) {
        button.addEventListener("pointerdown", ev => {
            if (layoutEditMode) return;
            ev.preventDefault();
            button.setPointerCapture?.(ev.pointerId);
            setTouchButton(button, true);
        });
        button.addEventListener("pointerup", ev => {
            ev.preventDefault();
            setTouchButton(button, false);
        });
        button.addEventListener("pointercancel", () => setTouchButton(button, false));
        button.addEventListener("lostpointercapture", () => setTouchButton(button, false));
        button.addEventListener("contextmenu", ev => ev.preventDefault());
    }

    document.addEventListener("fullscreenchange", () => {
        const fullscreen = document.fullscreenElement === shell;
        fullscreenButton.textContent = fullscreen ? "Exit fullscreen" : "Fullscreen";
        if (!fullscreen && screen.orientation?.unlock) {
            try { screen.orientation.unlock(); } catch { }
        }
    });

    window.addEventListener("blur", releaseAllTouchButtons);
    window.addEventListener("gamepadconnected", () => {
        updatePadChip();
        updatePadTestPanel();
    });
    window.addEventListener("gamepaddisconnected", () => {
        updatePadChip();
        updatePadTestPanel();
    });
    shell.addEventListener("touchend", handleDoubleTap, { passive: false });
    shell.addEventListener("dblclick", ev => {
        if (ev.target?.closest?.(".touch-btn, .player-overlay-action")) return;
        ev.preventDefault();
        toggleFullscreen();
    });

    window.addEventListener("keydown", ev => {
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
    connectButton.addEventListener("click", connect);
    audioButton.addEventListener("click", enableAudio);
    audioOverlayButton.addEventListener("click", ev => {
        if (layoutEditMode) {
            ev.preventDefault();
            return;
        }
        enableAudio();
    });
    layoutLockButton.addEventListener("click", () => {
        if (layoutEditMode) saveLayout();
        else setLayoutEditMode(true);
    });
    layoutResetButton?.addEventListener("click", ev => {
        ev.preventDefault();
        resetLayout();
    });
    fullscreenButton.addEventListener("click", toggleFullscreen);
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
    connect();
})();
