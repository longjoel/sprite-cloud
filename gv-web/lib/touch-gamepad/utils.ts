// ── Touch Gamepad — utility helpers ───────────────────────────────────────

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function pointInRect(px: number, py: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

const PERSIST_KEY = "gv:touch-layouts-v2";
const TOGGLE_KEY = "gv:touch-visible";

export function loadLayouts(): Record<string, any> {
  try {
    return JSON.parse(localStorage.getItem(PERSIST_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveLayouts(data: Record<string, any>): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(data));
  } catch {
    /* quota exceeded */
  }
}

export function loadToggleState(): boolean {
  try {
    return localStorage.getItem(TOGGLE_KEY) !== "0";
  } catch {
    return (
      typeof window !== "undefined" &&
      ("ontouchstart" in window || navigator.maxTouchPoints > 0)
    );
  }
}

export function saveToggleState(visible: boolean): void {
  try {
    localStorage.setItem(TOGGLE_KEY, visible ? "1" : "0");
  } catch {
    /* noop */
  }
}
