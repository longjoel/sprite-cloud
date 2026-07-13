// ── Touch Gamepad — utility helpers ───────────────────────────────────────

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function pointInRect(px: number, py: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

const PERSIST_KEY = "gv:touch-layouts-v3";
const LEGACY_PERSIST_KEY = "gv:touch-layouts-v2";
const TOGGLE_KEY = "gv:touch-visible";
const OPACITY_KEY = "gv:touch-opacity";
const SIZE_PRESET_KEY = "gv:touch-size-preset";

export type TouchOpacity = "low" | "medium" | "high";
export type NamedTouchSizePreset = "compact" | "standard" | "large";
export type TouchSizePreset = NamedTouchSizePreset | "custom";

function parseLayouts(value: string | null): Record<string, any> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function migrateVerticalRect<T>(rect: T): T {
  if (!rect || typeof rect !== "object") return rect;
  const value = rect as Record<string, any>;
  return {
    ...value,
    ...(typeof value.y === "number" ? { y: 0.5 + value.y * 0.5 } : {}),
    ...(typeof value.h === "number" ? { h: value.h * 0.5 } : {}),
  } as T;
}

function migrateV2Layouts(layouts: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(layouts).map(([key, layout]) => {
    if (!key.endsWith(":vertical") || !layout || typeof layout !== "object") {
      return [key, layout];
    }
    return [key, {
      ...layout,
      dpad: migrateVerticalRect(layout.dpad),
      face: Array.isArray(layout.face) ? layout.face.map(migrateVerticalRect) : layout.face,
      system: Array.isArray(layout.system) ? layout.system.map(migrateVerticalRect) : layout.system,
    }];
  }));
}

export function loadLayouts(): Record<string, any> {
  let currentValue: string | null;
  let legacyValue: string | null;
  try {
    currentValue = localStorage.getItem(PERSIST_KEY);
    legacyValue = localStorage.getItem(LEGACY_PERSIST_KEY);
  } catch {
    return {};
  }

  const current = parseLayouts(currentValue);
  if (currentValue !== null && current !== null) return current;

  const migrated = migrateV2Layouts(parseLayouts(legacyValue) || {});
  if (currentValue !== null || legacyValue !== null) {
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(migrated));
    } catch {
      /* Best effort: the migrated layout remains usable for this session. */
    }
  }
  return migrated;
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

export function loadOpacity(): TouchOpacity {
  try {
    const value = localStorage.getItem(OPACITY_KEY);
    return value === "low" || value === "high" ? value : "medium";
  } catch {
    return "medium";
  }
}

export function saveOpacity(opacity: TouchOpacity): void {
  try {
    localStorage.setItem(OPACITY_KEY, opacity);
  } catch {
    /* noop */
  }
}

export function loadSizePreset(): TouchSizePreset {
  try {
    const value = localStorage.getItem(SIZE_PRESET_KEY);
    return value === "compact" || value === "large" || value === "custom" ? value : "standard";
  } catch {
    return "standard";
  }
}

export function saveSizePreset(size: TouchSizePreset): void {
  try {
    localStorage.setItem(SIZE_PRESET_KEY, size);
  } catch {
    /* noop */
  }
}
