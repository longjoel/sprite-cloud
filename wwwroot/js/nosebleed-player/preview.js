(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.GamesVaultNosebleedPreview = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
    function buildVideoWebSocketUrl(previewUrl) {
        if (!previewUrl) return null;
        try {
            const url = new URL(previewUrl, typeof window !== "undefined" ? window.location.href : undefined);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            return url.toString();
        } catch {
            return null;
        }
    }

    function magic(view, offset) {
        return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    }

    function renderFrame(canvas, buffer) {
        const data = new DataView(buffer);
        if (data.byteLength < 37 || magic(data, 0) !== "NBF0") return false;

        const width = data.getUint32(20, true);
        const height = data.getUint32(24, true);
        const pitch = data.getUint32(28, true);
        const pixelFormat = data.getUint8(32);
        const payloadLen = data.getUint32(33, true);
        const offset = 37;
        if (width <= 0 || height <= 0 || data.byteLength < offset + payloadLen) return false;

        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }

        const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
        const image = ctx.createImageData(width, height);
        const out = image.data;
        const src = new Uint8Array(buffer, offset, payloadLen);

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

        ctx.putImageData(image, 0, 0);
        return true;
    }

    function startPreview(card) {
        const canvas = card.querySelector("canvas[data-nosebleed-preview-canvas]");
        const status = card.querySelector("[data-nosebleed-preview-status]");
        const url = buildVideoWebSocketUrl(card.dataset.previewUrl);
        if (!canvas || !url) return;

        let frames = 0;
        const setStatus = text => { if (status) status.textContent = text; };
        setStatus("Connecting preview…");

        try {
            const ws = new WebSocket(url);
            ws.binaryType = "arraybuffer";
            ws.onopen = () => setStatus("Preview connected…");
            ws.onmessage = ev => {
                if (renderFrame(canvas, ev.data)) {
                    frames++;
                    if (frames === 1) setStatus("Preview live");
                }
            };
            ws.onerror = () => setStatus("Preview unavailable");
            ws.onclose = () => {
                if (frames === 0) setStatus("Preview offline");
            };
        } catch {
            setStatus("Preview unavailable");
        }
    }

    function startAll() {
        if (typeof document === "undefined") return;
        for (const card of document.querySelectorAll("[data-nosebleed-preview-card]")) {
            startPreview(card);
        }
    }

    if (typeof document !== "undefined") {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startAll, { once: true });
        else startAll();
    }

    return { buildVideoWebSocketUrl, renderFrame, startPreview, startAll };
});
