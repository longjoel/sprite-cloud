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
        const url = card.dataset.previewUrl;
        if (!canvas || !url) return;

        const setStatus = text => { if (status) status.textContent = text; };
        setStatus("Loading preview\u2026");

        // Poll the preview endpoint — the session may not be ready immediately
        let attempts = 0;
        const maxAttempts = 30; // 30 * 500ms = 15s timeout
        const poll = () => {
            attempts++;
            fetch(url)
                .then(resp => {
                    if (!resp.ok) throw new Error("not ready");
                    return resp.blob();
                })
                .then(blob => createImageBitmap(blob))
                .then(bitmap => {
                    ensureCanvasSize(canvas, bitmap.width, bitmap.height);
                    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
                    ctx.drawImage(bitmap, 0, 0);
                    bitmap.close();
                    setStatus("Preview live");
                })
                .catch(() => {
                    if (attempts < maxAttempts) {
                        setTimeout(poll, 500);
                    } else {
                        setStatus("Preview offline");
                    }
                });
        };
        poll();
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

    return { startPreview, startAll };
});
