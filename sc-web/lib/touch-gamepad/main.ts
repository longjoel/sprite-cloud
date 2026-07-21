// ── Touch Gamepad — entry point (browser IIFE) ────────────────────────────
//
// Bundled with esbuild into public/player/touch-gamepad-v2.js.
// Exposes `TouchGamepad` at `window.TouchGamepad` and auto-instantiates
// `window.__scTouchGamepad` when the video element has `data-sc-preset`.

import { TouchGamepad } from "./index";

// Expose the constructor globally (same API as the v1 script)
(window as any).TouchGamepad = TouchGamepad;

// Auto-instantiate from video element (same convention as original)
function bootstrap(): void {
  const video = document.querySelector<HTMLVideoElement>(
    "video[data-sc-preset]"
  );
  if (!video) {
    // Retry — video may not be in the DOM yet
    requestAnimationFrame(bootstrap);
    return;
  }
  if ((window as any).__scTouchGamepad) return; // already bootstrapped

  const preset = video.dataset.scPreset || "nes";
  const layout = video.dataset.scLayout || "auto";

  const gp = new (TouchGamepad as any)(video, { preset, layout });
  (window as any).__scTouchGamepad = gp;
}

// Wait for DOM to be ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(bootstrap));
} else {
  requestAnimationFrame(bootstrap);
}
