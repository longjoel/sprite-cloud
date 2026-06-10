(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.GamesVaultNosebleedPreview = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
    function ensureCanvasSize(canvas, width, height) {
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
    }

    function startPreview(card) {
        const canvas = card.querySelector("canvas[data-nosebleed-preview-canvas]");
        const status = card.querySelector("[data-nosebleed-preview-status]");
        const snapshotUrl = card.dataset.previewUrl;
        const streamUrl = card.dataset.streamUrl;
        if (!canvas || (!snapshotUrl && !streamUrl)) return;

        const setStatus = text => { if (status) status.textContent = text; };
        setStatus("Loading preview\u2026");

        let ws = null;
        let wsActive = false;
        let pollingTimer = null;
        let frameCount = 0;
        const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });

        // --- WebSocket streaming (preferred) ---
        function startWebSocketStream() {
            if (!streamUrl) return false;
            // Resolve relative URLs to absolute WebSocket URLs
            var wsUrl = streamUrl;
            if (wsUrl.startsWith("/")) {
                var loc = window.location;
                var scheme = loc.protocol === "https:" ? "wss:" : "ws:";
                wsUrl = scheme + "//" + loc.host + wsUrl;
            }
            try {
                ws = new WebSocket(wsUrl);
                ws.binaryType = "arraybuffer";
                ws.onopen = () => {
                    wsActive = true;
                    setStatus("Streaming");
                };
                ws.onmessage = async (evt) => {
                    if (!(evt.data instanceof ArrayBuffer)) return;
                    try {
                        const blob = new Blob([evt.data], { type: "image/jpeg" });
                        const bitmap = await createImageBitmap(blob);
                        ensureCanvasSize(canvas, bitmap.width, bitmap.height);
                        ctx.drawImage(bitmap, 0, 0);
                        bitmap.close();
                        frameCount++;
                    } catch (e) {
                        // skip bad frames
                    }
                };
                ws.onclose = () => {
                    wsActive = false;
                    ws = null;
                    if (frameCount === 0) {
                        // WebSocket never delivered a frame — fall back to polling
                        setStatus("Connecting\u2026");
                        startPolling();
                    }
                };
                ws.onerror = () => {
                    wsActive = false;
                    ws = null;
                    if (frameCount === 0) {
                        startPolling();
                    }
                };
                return true;
            } catch (e) {
                return false;
            }
        }

        // --- HTTP polling (fallback) ---
        function startPolling() {
            if (!snapshotUrl) return;
            setStatus("Polling");
            let attempts = 0;
            const maxAttempts = 60;
            const poll = () => {
                attempts++;
                fetch(snapshotUrl)
                    .then(resp => {
                        if (!resp.ok) throw new Error("not ready");
                        return resp.blob();
                    })
                    .then(blob => createImageBitmap(blob))
                    .then(bitmap => {
                        ensureCanvasSize(canvas, bitmap.width, bitmap.height);
                        ctx.drawImage(bitmap, 0, 0);
                        bitmap.close();
                        frameCount++;
                        // Continue polling at 2fps
                        pollingTimer = setTimeout(poll, 500);
                    })
                    .catch(() => {
                        if (attempts < maxAttempts) {
                            pollingTimer = setTimeout(poll, 1000);
                        } else {
                            setStatus("Preview offline");
                        }
                    });
            };
            poll();
        }

        // Try WebSocket first, fall back to polling
        if (!startWebSocketStream()) {
            startPolling();
        }

        // Return a cleanup function
        return () => {
            if (ws) {
                try { ws.close(); } catch (e) { /* ignore */ }
                ws = null;
            }
            if (pollingTimer) {
                clearTimeout(pollingTimer);
                pollingTimer = null;
            }
        };
    }

    const cleanups = new WeakMap();

    function startAll() {
        if (typeof document === "undefined") return;
        for (const card of document.querySelectorAll("[data-nosebleed-preview-card]")) {
            const existing = cleanups.get(card);
            if (existing) existing();
            cleanups.set(card, startPreview(card));
        }
    }

    if (typeof document !== "undefined") {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startAll, { once: true });
        else startAll();
    }

    return { startPreview, startAll };
});
