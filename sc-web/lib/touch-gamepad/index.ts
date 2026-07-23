// ── Touch Gamepad — main class ─────────────────────────────────────────────

import type {
  NormalisedRect, ButtonZone, LayoutData, PresetName, Orientation,
  DragTarget, TouchGamepadOptions, InputCallback,
} from "./types";
import { PRESETS, computeDefaults } from "./presets";
import {
  loadLayouts, loadOpacity, loadSizePreset, saveLayouts, saveOpacity, saveSizePreset,
  saveToggleState, type NamedTouchSizePreset, type TouchOpacity, type TouchSizePreset,
} from "./utils";

interface TouchGamepad {
  _video: HTMLVideoElement;
  _preset: PresetName;
  _layoutName: Orientation;
  _dpad: NormalisedRect;
  _face: ButtonZone[];
  _system: ButtonZone[];
  _dpadActive: [boolean, boolean, boolean, boolean];
  _faceStates: boolean[];
  _systemStates: boolean[];
  _canvas: HTMLCanvasElement | null;
  _islandLayer: HTMLDivElement | null;
  _ctx: CanvasRenderingContext2D | null;
  _visible: boolean;
  _inputSuspended: boolean;
  _reducedMotion: boolean;
  _animId: number | null;
  _dragTarget: DragTarget | null;
  _dragStart: {
    fingerId: number;
    nx: number; ny: number;
    tx: number; ty: number; tw: number; th: number;
    mode: "resize" | "move";
  } | null;
  _editMode: boolean;
  _showHandles: boolean;
  _opacity: TouchOpacity;
  _sizePreset: TouchSizePreset;
  _activePointers: Map<number, { identifier: number; clientX: number; clientY: number; target: HTMLElement }>;
  _blockedPointerIds: Set<number>;
  onInput: InputCallback | null;
  _layouts: Record<string, any>;
  _castMode: boolean;
  // Bound handlers

  _onPointerDown: (e: PointerEvent) => void;
  _onPointerMove: (e: PointerEvent) => void;
  _onPointerUp: (e: PointerEvent) => void;
  _onOrientationChange: () => void;
  _render: () => void;
}

function TouchGamepad(this: TouchGamepad, video: HTMLVideoElement, opts?: TouchGamepadOptions) {
  opts = opts || {};
  this._video = video;
  this._preset = (opts.preset || "nes") as PresetName;
  this._layoutName = opts.layout || "auto";

  this._dpad = { x: 0, y: 0, w: 0, h: 0 };
  this._face = [];
  this._system = [];
  this._dpadActive = [false, false, false, false];
  this._faceStates = [];
  this._systemStates = [];
  this._canvas = null;
  this._islandLayer = null;
  this._ctx = null;
  this._visible = false;
  this._inputSuspended = false;
  this._reducedMotion = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  this._animId = null;
  this._dragTarget = null;
  this._dragStart = null;
  this._editMode = false;
  this._showHandles = false;
  this._opacity = loadOpacity();
  this._sizePreset = loadSizePreset();
  this._activePointers = new Map();
  this._blockedPointerIds = new Set();
  this.onInput = null;
  this._castMode = false;

  this._layouts = loadLayouts();
  (this as any)._loadLayout();

  // Bind handlers

  this._onPointerDown = (this as any)._onPointerDown.bind(this);
  this._onPointerMove = (this as any)._onPointerMove.bind(this);
  this._onPointerUp = (this as any)._onPointerUp.bind(this);
  this._onOrientationChange = (this as any)._onOrientationChange.bind(this);
  this._render = (this as any)._render.bind(this);
}

// ── Layout key ─────────────────────────────────────────────────────────────

function resolveOrientation(layoutName: Orientation): string {
  if (layoutName === "horizontal") return "horizontal";
  if (layoutName === "vertical") return "vertical";
  if (!window.screen) return "vertical";
  return window.innerWidth > window.innerHeight ? "horizontal" : "vertical";
}

function layoutKey(this: TouchGamepad): string {
  return this._preset + ":" + resolveOrientation(this._layoutName);
}

// ── Layout load/save ─────────────────────────────────────────────────────

(TouchGamepad.prototype as any)._loadLayout = function (this: TouchGamepad) {
  const orientation = resolveOrientation(this._layoutName);
  const key = this._preset + ":" + orientation;
  const stored = this._layouts[key] || null;
  const defaults = computeDefaults(this._preset, orientation);
  const expected = PRESETS[this._preset] || PRESETS.nes;
  const labelsMatch = (group: any, config: Array<{ label: string }>) =>
    Array.isArray(group)
    && group.length === config.length
    && group.every((button: any, index: number) => button?.label === config[index].label);

  const dpad = stored?.dpad || defaults.dpad;
  const face = stored && labelsMatch(stored.face, expected.face) ? stored.face : defaults.face;
  const system = stored && labelsMatch(stored.system, expected.system) ? stored.system : defaults.system;
  const migrated = stored && (face !== stored.face || system !== stored.system);
  const src = { dpad, face, system };

  this._dpad = { x: src.dpad.x, y: src.dpad.y, w: src.dpad.w, h: src.dpad.h };
  this._face = src.face.map((b: any) => ({
    x: b.x, y: b.y, w: b.w, h: b.h, label: b.label || "",
  }));
  this._system = src.system.map((b: any) => ({
    x: b.x, y: b.y, w: b.w, h: b.h, label: b.label || "",
  }));
  this._faceStates = new Array(this._face.length).fill(false);
  this._systemStates = new Array(this._system.length).fill(false);

  if (migrated) {
    this._layouts[key] = {
      dpad: { ...this._dpad },
      face: this._face.map((button) => ({ ...button })),
      system: this._system.map((button) => ({ ...button })),
    };
    saveLayouts(this._layouts);
  }
};

(TouchGamepad.prototype as any)._saveLayout = function (this: TouchGamepad) {
  const key = layoutKey.call(this);
  this._layouts[key] = {
    dpad: { x: this._dpad.x, y: this._dpad.y, w: this._dpad.w, h: this._dpad.h },
    face: this._face.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, label: b.label })),
    system: this._system.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, label: b.label })),
  };
  saveLayouts(this._layouts);
};

// ── Preset / Layout switching ─────────────────────────────────────────────

TouchGamepad.prototype.setPreset = function (this: TouchGamepad, preset: string) {
  if (!PRESETS[preset]) return;
  this._preset = preset as PresetName;
  (this as any)._loadLayout();
  (this as any)._syncTouchIslands();
  if (this._visible) { (this as any)._resizeCanvas(); (this as any)._scheduleRender(); }
};

TouchGamepad.prototype.setLayout = function (this: TouchGamepad, layout: string) {
  this._layoutName = layout as Orientation;
  (this as any)._loadLayout();
  (this as any)._syncTouchIslands();
  if (this._visible) { (this as any)._resizeCanvas(); (this as any)._scheduleRender(); }
};

// ── Edit mode ──────────────────────────────────────────────────────────────

TouchGamepad.prototype.enterEditMode = function (this: TouchGamepad) {
  this._editMode = true;
  this._showHandles = true;
  (this as any)._scheduleRender();
};

TouchGamepad.prototype.exitEditMode = function (this: TouchGamepad) {
  this._editMode = false;
  this._showHandles = false;
  (this as any)._saveLayout();
  (this as any)._syncTouchIslands();
  (this as any)._scheduleRender();
};

TouchGamepad.prototype.setOpacity = function (this: TouchGamepad, opacity: TouchOpacity) {
  if (opacity !== "low" && opacity !== "medium" && opacity !== "high" && opacity !== "max") return;
  this._opacity = opacity;
  saveOpacity(opacity);
  if (this._canvas) this._canvas.style.opacity = String({ low: 0.35, medium: 0.55, high: 0.8, max: 0.95 }[opacity]);
};

TouchGamepad.prototype.getOpacity = function (this: TouchGamepad): TouchOpacity {
  return this._opacity;
};

TouchGamepad.prototype.setSizePreset = function (this: TouchGamepad, size: NamedTouchSizePreset) {
  const scale = { compact: 0.85, standard: 1, large: 1.2 }[size];
  if (!scale) return;
  this._sizePreset = size;
  saveSizePreset(size);
  const defaults = computeDefaults(this._preset, resolveOrientation(this._layoutName));
  const resizeAroundCenter = (zone: NormalisedRect, defaultZone: NormalisedRect) => {
    const centerX = zone.x + zone.w / 2;
    const centerY = zone.y + zone.h / 2;
    zone.w = Math.min(1, defaultZone.w * scale);
    zone.h = Math.min(1, defaultZone.h * scale);
    zone.x = Math.max(0, Math.min(1 - zone.w, centerX - zone.w / 2));
    zone.y = Math.max(0, Math.min(1 - zone.h, centerY - zone.h / 2));
  };
  resizeAroundCenter(this._dpad, defaults.dpad);
  this._face.forEach((zone, index) => resizeAroundCenter(zone, defaults.face[index]));
  this._system.forEach((zone, index) => resizeAroundCenter(zone, defaults.system[index]));
  if (this._visible) (this as any)._resizeCanvas();
  (this as any)._saveLayout();
  (this as any)._syncTouchIslands();
  (this as any)._scheduleRender();
};

TouchGamepad.prototype.getSizePreset = function (this: TouchGamepad): TouchSizePreset {
  return this._sizePreset;
};

TouchGamepad.prototype.resetLayout = function (this: TouchGamepad) {
  delete this._layouts[layoutKey.call(this)];
  saveLayouts(this._layouts);
  (this as any)._loadLayout();
  this._sizePreset = "standard";
  saveSizePreset("standard");
  if (this._visible) (this as any)._resizeCanvas();
  (this as any)._syncTouchIslands();
  (this as any)._scheduleRender();
};

// ── AB/XY swap ─────────────────────────────────────────────────────────────

TouchGamepad.prototype.swapAB = function (this: TouchGamepad) {
  if (this._face.length < 2) return;
  const swap = (f: ButtonZone[], i: number, j: number) => {
    const tmp = { x: f[i].x, y: f[i].y, w: f[i].w, h: f[i].h };
    f[i].x = f[j].x; f[i].y = f[j].y; f[i].w = f[j].w; f[i].h = f[j].h;
    f[j].x = tmp.x; f[j].y = tmp.y; f[j].w = tmp.w; f[j].h = tmp.h;
  };
  swap(this._face, 0, 1);
  if (this._face.length >= 4) swap(this._face, 2, 3);
  (this as any)._saveLayout();
  (this as any)._syncTouchIslands();
  if (this._visible) (this as any)._scheduleRender();
};

// ── Show / hide / toggle ──────────────────────────────────────────────────

TouchGamepad.prototype.show = function (this: TouchGamepad) {
  if (this._visible) return;
  this._visible = true;
  (this as any)._ensureCanvas();
  if (this._islandLayer) this._islandLayer.style.display = "block";
  if (this._layoutName === "auto") {
    window.addEventListener("orientationchange", this._onOrientationChange);
  }
  (this as any)._resizeCanvas();
  (this as any)._scheduleRender();
  saveToggleState(true);
};

TouchGamepad.prototype.hide = function (this: TouchGamepad) {
  this._visible = false;
  if (this._canvas) this._canvas.style.display = "none";
  if (this._islandLayer) this._islandLayer.style.display = "none";
  if (this._animId) { cancelAnimationFrame(this._animId); this._animId = null; }
  this._video.style.maxHeight = "";
  this._video.style.objectFit = "";
  (this as any)._clearInputs();
  this._dragTarget = null;
  this._dragStart = null;
  this._activePointers.forEach((pointer, id) => pointer.target.releasePointerCapture?.(id));
  this._activePointers.clear();
  this._blockedPointerIds.clear();
  (this as any)._emitState();
  if (this._layoutName === "auto") {
    window.removeEventListener("orientationchange", this._onOrientationChange);
  }
  saveToggleState(false);
};

TouchGamepad.prototype.suspendInput = function (this: TouchGamepad) {
  this._inputSuspended = true;
  if (this._canvas) this._canvas.style.filter = "brightness(0.45)";
  this._activePointers.forEach((pointer, id) => {
    this._blockedPointerIds.add(id);
    pointer.target.releasePointerCapture?.(id);
  });
  if (this._islandLayer) {
    this._islandLayer.querySelectorAll<HTMLElement>("[data-touch-target]")
      .forEach((target) => { target.style.pointerEvents = "none"; });
  }
  (this as any)._clearInputs();
  this._dragTarget = null;
  this._dragStart = null;
  this._activePointers.clear();
  (this as any)._emitState();
};

TouchGamepad.prototype.resumeInput = function (this: TouchGamepad) {
  this._inputSuspended = false;
  if (this._canvas) this._canvas.style.filter = "";
  this._blockedPointerIds.clear();
  if (this._islandLayer) {
    this._islandLayer.querySelectorAll<HTMLElement>("[data-touch-target]")
      .forEach((target) => { target.style.pointerEvents = "auto"; });
  }
};

TouchGamepad.prototype.toggle = function (this: TouchGamepad) {
  if (this._visible) TouchGamepad.prototype.hide.call(this);
  else TouchGamepad.prototype.show.call(this);
};

TouchGamepad.prototype.isVisible = function (this: TouchGamepad) {
  return this._visible;
};

TouchGamepad.prototype.destroy = function (this: TouchGamepad) {
  TouchGamepad.prototype.hide.call(this);
  if (this._canvas && this._canvas.parentNode) {
    this._canvas.parentNode.removeChild(this._canvas);
  }
  if (this._islandLayer?.parentNode) {
    this._islandLayer.parentNode.removeChild(this._islandLayer);
  }
  this._canvas = null;
  this._islandLayer = null;
  this._ctx = null;
};

// ── Canvas setup ──────────────────────────────────────────────────────────

(TouchGamepad.prototype as any)._ensureCanvas = function (this: TouchGamepad) {
  if (this._canvas) {
    this._canvas.style.display = "block";
    return;
  }
  const c = document.createElement("canvas");
  c.style.position = "absolute";
  c.style.touchAction = "none";
  c.style.pointerEvents = "none";
  c.style.zIndex = "10";
  c.style.opacity = String({ low: 0.35, medium: 0.55, high: 0.8, max: 0.95 }[this._opacity]);
  c.dataset.reducedMotion = String(this._reducedMotion);

  const parent = this._video.parentNode as HTMLElement | null;
  if (parent && getComputedStyle(parent).position === "static") {
    parent.style.position = "relative";
  }
  parent!.appendChild(c);
  this._canvas = c;
  this._ctx = c.getContext("2d")!;

  const layer = document.createElement("div");
  layer.dataset.touchIslands = "";
  Object.assign(layer.style, {
    position: "absolute", pointerEvents: "none", touchAction: "none", zIndex: "11",
    boxSizing: "border-box",
  });
  for (const kind of ["dpad", "face", "system"]) {
    const island = document.createElement("div");
    island.dataset.touchIsland = kind;
    island.setAttribute("role", "group");
    island.setAttribute("aria-label", `${kind} touch controls`);
    Object.assign(island.style, { position: "absolute", inset: "0", pointerEvents: "none", touchAction: "none" });
    layer.appendChild(island);
  }
  parent!.appendChild(layer);
  this._islandLayer = layer;
  (this as any)._syncTouchIslands();

  layer.addEventListener("pointerdown", this._onPointerDown);
  layer.addEventListener("pointermove", this._onPointerMove);
  layer.addEventListener("pointerup", this._onPointerUp);
  layer.addEventListener("pointercancel", this._onPointerUp);
};

(TouchGamepad.prototype as any)._syncTouchIslands = function (this: TouchGamepad) {
  if (!this._islandLayer) return;
  const groups = Object.fromEntries(Array.from(this._islandLayer.children).map((el) => [
    (el as HTMLElement).dataset.touchIsland!, el as HTMLElement,
  ])) as Record<string, HTMLElement>;
  const setIslandBounds = (group: HTMLElement, rects: NormalisedRect[]) => {
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.w));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
    Object.assign(group.style, { inset: "0", pointerEvents: "none" });
    return { left, top, width: right - left, height: bottom - top };
  };
  const bounds = {
    dpad: setIslandBounds(groups.dpad, [this._dpad]),
    face: setIslandBounds(groups.face, this._face),
    system: setIslandBounds(groups.system, this._system),
  };
  const desiredTargets = new Set<string>();
  const target = (group: HTMLElement, rect: NormalisedRect, label: string, _bound: { left: number; top: number; width: number; height: number }) => {
    desiredTargets.add(label);
    const el = group.querySelector<HTMLElement>(`[data-touch-target="${label}"]`)
      ?? document.createElement("span");
    el.dataset.touchTarget = label;
    el.dataset.normX = String(rect.x);
    el.dataset.normY = String(rect.y);
    el.dataset.normW = String(rect.w);
    el.dataset.normH = String(rect.h);
    el.setAttribute("aria-hidden", "true");
    Object.assign(el.style, {
      position: "absolute",
      left: `${(rect.x + rect.w / 2) * 100}%`,
      top: `${(rect.y + rect.h / 2) * 100}%`,
      transform: "translate(-50%, -50%)",
      width: `${rect.w * 100}%`,
      height: `${rect.h * 100}%`,
      minWidth: "44px", minHeight: "44px", boxSizing: "border-box", borderStyle: "solid",
      borderWidth: "2px", borderColor: "transparent", pointerEvents: this._inputSuspended ? "none" : "auto",
    });
    return el;
  };
  const attachIfNeeded = (group: HTMLElement, el: HTMLElement) => {
    if (el.parentElement !== group) group.appendChild(el);
  };
  attachIfNeeded(groups.dpad, target(groups.dpad, this._dpad, "dpad", bounds.dpad));
  this._face.forEach((zone, i) => attachIfNeeded(groups.face, target(groups.face, zone, `face-${i}`, bounds.face)));
  this._system.forEach((zone, i) => attachIfNeeded(groups.system, target(groups.system, zone, `system-${i}`, bounds.system)));
  this._islandLayer.querySelectorAll<HTMLElement>("[data-touch-target]").forEach((el) => {
    if (!desiredTargets.has(el.dataset.touchTarget!)) el.remove();
  });
};

// ── Canvas resize ─────────────────────────────────────────────────────────

(TouchGamepad.prototype as any)._resizeCanvas = function (this: TouchGamepad) {
  if (!this._canvas) return;
  const orientation = resolveOrientation(this._layoutName);
  let w: number, h: number;
  const safeLeft = "env(safe-area-inset-left, 0px)";
  const safeRight = "env(safe-area-inset-right, 0px)";
  const safeTop = "env(safe-area-inset-top, 0px)";
  const safeBottom = "env(safe-area-inset-bottom, 0px)";

  this._canvas.style.setProperty("--touch-safe-left", safeLeft);
  this._canvas.style.setProperty("--touch-safe-right", safeRight);
  this._canvas.style.setProperty("--touch-safe-top", safeTop);
  this._canvas.style.setProperty("--touch-safe-bottom", safeBottom);

  if (this._castMode) {
    Object.assign(this._canvas.style, {
      position: "fixed", left: safeLeft, right: safeRight, top: safeTop, bottom: safeBottom,
      width: `calc(100vw - ${safeLeft} - ${safeRight})`,
      height: `calc(100vh - ${safeTop} - ${safeBottom})`, zIndex: "20",
    });
    w = Math.round(window.innerWidth);
    h = Math.round(window.innerHeight);
  } else if (orientation === "vertical") {
    Object.assign(this._canvas.style, {
      position: "fixed",
      left: "var(--touch-safe-left, 0px)", right: "var(--touch-safe-right, 0px)",
      top: "var(--touch-safe-top, 0px)", bottom: "var(--touch-safe-bottom, 0px)",
      width: "calc(100vw - var(--touch-safe-left, 0px) - var(--touch-safe-right, 0px))",
      height: "calc(100vh - var(--touch-safe-top, 0px) - var(--touch-safe-bottom, 0px))", zIndex: "10",
    });
    this._video.style.maxHeight = "50vh";
    this._video.style.objectFit = "contain";
    w = Math.round(window.innerWidth);
    h = Math.round(window.innerHeight);
  } else {
    const vr = this._video.getBoundingClientRect();
    const pr = (this._canvas.parentNode as HTMLElement).getBoundingClientRect();
    w = Math.round(vr.width);
    h = Math.round(vr.height);
    Object.assign(this._canvas.style, {
      position: "absolute",
      left: `calc(${vr.left - pr.left}px + ${safeLeft})`, right: safeRight,
      top: `calc(${vr.top - pr.top}px + ${safeTop})`, bottom: safeBottom,
      width: `calc(${w}px - ${safeLeft} - ${safeRight})`,
      height: `calc(${h}px - ${safeTop} - ${safeBottom})`, zIndex: "10",
    });
    this._video.style.maxHeight = "";
    this._video.style.objectFit = "";
  }

  if (w !== this._canvas.width || h !== this._canvas.height) {
    this._canvas.width = w;
    this._canvas.height = h;
  }

  // Face and system controls must remain comfortably finger-sized even when a
  // saved layout was created on a differently sized/oriented screen.
  const minW = Math.min(1, 56 / Math.max(1, w));
  const minH = Math.min(1, 56 / Math.max(1, h));
  for (const zone of [...this._face, ...this._system]) {
    const nextW = Math.max(zone.w, minW);
    const nextH = Math.max(zone.h, minH);
    if (nextW === zone.w && nextH === zone.h) continue;
    const centerX = zone.x + zone.w / 2;
    const centerY = zone.y + zone.h / 2;
    zone.w = nextW;
    zone.h = nextH;
    zone.x = Math.max(0, Math.min(1 - zone.w, centerX - zone.w / 2));
    zone.y = Math.max(0, Math.min(1 - zone.h, centerY - zone.h / 2));
  }
  if (this._islandLayer) {
    for (const edge of ["left", "right", "top", "bottom"]) {
      this._islandLayer.style.setProperty(
        `--touch-safe-${edge}`,
        this._canvas.style.getPropertyValue(`--touch-safe-${edge}`),
      );
    }
    Object.assign(this._islandLayer.style, {
      position: this._canvas.style.position,
      left: this._canvas.style.left,
      right: this._canvas.style.right,
      top: this._canvas.style.top,
      bottom: this._canvas.style.bottom,
      width: this._canvas.style.width,
      height: this._canvas.style.height,
    });
    (this as any)._syncTouchIslands();
  }
};

(TouchGamepad.prototype as any)._scheduleRender = function (this: TouchGamepad) {
  if (!this._animId) {
    this._animId = requestAnimationFrame(this._render);
  }
};

// ── Orientation change ────────────────────────────────────────────────────

(TouchGamepad.prototype as any)._onOrientationChange = function (this: TouchGamepad) {
  if (!this._visible) return;
  this._dragTarget = null;
  this._dragStart = null;
  this._activePointers.forEach((pointer, id) => pointer.target.releasePointerCapture?.(id));
  this._activePointers.clear();
  (this as any)._clearInputs();
  (this as any)._emitState();
  const self = this;
  setTimeout(() => {
    (self as any)._loadLayout();
    (self as any)._resizeCanvas();
  }, 200);
};

// ── Touch → norm ──────────────────────────────────────────────────────────

function touchToNorm(this: TouchGamepad, touch: Touch) {
  const rect = this._canvas!.getBoundingClientRect();
  return {
    x: (touch.clientX - rect.left) / rect.width,
    y: (touch.clientY - rect.top) / rect.height,
  };
}

// ── Zone finder ───────────────────────────────────────────────────────────

(TouchGamepad.prototype as any)._findTouchZone = function (this: TouchGamepad, n: { x: number; y: number }, preferredTarget?: string) {
  const nx = n.x, ny = n.y;
  const canvasRect = this._canvas?.getBoundingClientRect();
  // A forgiving 28px corner radius works for broad fingertips. Convert each
  // axis independently so short landscape canvases do not shrink vertical
  // resize handles.
  // 56px finger-friendly radius in edit mode (28px was too small,
  // especially on narrow portrait phones where controls pack tightly).
  const RESIZE_RX = 56 / (canvasRect?.width || 1);
  const RESIZE_RY = 56 / (canvasRect?.height || 1);

  if (this._showHandles) {
    const d = this._dpad;
    const corners = [
      { x: d.x, y: d.y, tag: "resize:dpad:nw" },
      { x: d.x + d.w, y: d.y, tag: "resize:dpad:ne" },
      { x: d.x, y: d.y + d.h, tag: "resize:dpad:sw" },
      { x: d.x + d.w, y: d.y + d.h, tag: "resize:dpad:se" },
    ];
    for (const c of corners) {
      if (preferredTarget && preferredTarget !== "dpad") continue;
      if (Math.abs(nx - c.x) < RESIZE_RX && Math.abs(ny - c.y) < RESIZE_RY) {
        return { kind: "resize", zone: "dpad", tag: c.tag };
      }
    }
    for (const [zoneName, zones] of [["face", this._face], ["system", this._system]] as const) {
      for (let i = 0; i < zones.length; i++) {
        if (preferredTarget && preferredTarget !== `${zoneName}-${i}`) continue;
        const button = zones[i];
        const corners = [
          { x: button.x, y: button.y, tag: "nw" },
          { x: button.x + button.w, y: button.y, tag: "ne" },
          { x: button.x, y: button.y + button.h, tag: "sw" },
          { x: button.x + button.w, y: button.y + button.h, tag: "se" },
        ];
        for (const corner of corners) {
          if (Math.abs(nx - corner.x) < RESIZE_RX && Math.abs(ny - corner.y) < RESIZE_RY) {
            return { kind: "resize", zone: zoneName, index: i, tag: `resize:${zoneName}:${corner.tag}` };
          }
        }
      }
    }
  }

  if (nx >= this._dpad.x && nx <= this._dpad.x + this._dpad.w && ny >= this._dpad.y && ny <= this._dpad.y + this._dpad.h) {
    return { kind: "dpad" };
  }
  for (let i = 0; i < this._face.length; i++) {
    const f = this._face[i];
    if (nx >= f.x && nx <= f.x + f.w && ny >= f.y && ny <= f.y + f.h) {
      return { kind: "face", zone: String(i) };
    }
  }
  for (let i = 0; i < this._system.length; i++) {
    const s = this._system[i];
    if (nx >= s.x && nx <= s.x + s.w && ny >= s.y && ny <= s.y + s.h) {
      return { kind: "system", zone: String(i) };
    }
  }
  return null;
};

// ── Input handling ───────────────────────────────────────────────────────

(TouchGamepad.prototype as any)._clearInputs = function (this: TouchGamepad) {
  this._dpadActive = [false, false, false, false];
  this._faceStates = this._faceStates.map(() => false);
  this._systemStates = this._systemStates.map(() => false);
};

(TouchGamepad.prototype as any)._emitState = function (this: TouchGamepad) {
  if (this.onInput) {
    this.onInput({
      dpad: this._dpadActive,
      face: this._faceStates,
      system: this._systemStates,
    });
  }
};

// ── Render ─────────────────────────────────────────────────────────────────

(TouchGamepad.prototype as any)._render = function (this: TouchGamepad) {
  const canvas = this._canvas;
  if (!canvas || !this._ctx) return;
  const ctx = this._ctx;
  const cw = canvas.width;
  const ch = canvas.height;

  ctx.clearRect(0, 0, cw, ch);

  // D-pad
  drawDpad(this, ctx, cw, ch);

  // Face buttons
  for (let i = 0; i < this._face.length; i++) {
    drawButton(ctx, this._face[i], cw, ch, this._faceStates[i], this._editMode || this._showHandles);
  }

  // System buttons
  for (let i = 0; i < this._system.length; i++) {
    drawButton(ctx, this._system[i], cw, ch, this._systemStates[i], this._editMode || this._showHandles);
  }

  // Resize handles (edit mode) — during drag, only the active target's handles are shown
  if (this._showHandles) {
    const isDragging = !!this._dragTarget;
    const dragZone = this._dragTarget?.zone;
    const dragIndex = this._dragTarget?.index;

    const showDpad = !isDragging || dragZone === "dpad";
    drawResizeHandles(ctx, this._dpad, cw, ch, showDpad);
    for (let i = 0; i < this._face.length; i++) {
      const showFace = !isDragging || (dragZone === "face" && dragIndex === i);
      drawResizeHandles(ctx, this._face[i], cw, ch, showFace);
    }
    for (let i = 0; i < this._system.length; i++) {
      const showSys = !isDragging || (dragZone === "system" && dragIndex === i);
      drawResizeHandles(ctx, this._system[i], cw, ch, showSys);
    }
  }

  // Drag label feedback — show the control name while dragging
  if (this._dragTarget) {
    let tgt: NormalisedRect | null = null;
    let label = "";
    if (this._dragTarget.zone === "dpad") { tgt = this._dpad; label = "DPAD"; }
    else if (this._dragTarget.zone === "face") { tgt = this._face[this._dragTarget.index!]; label = (this._face[this._dragTarget.index!] as any)?.label || ""; }
    else if (this._dragTarget.zone === "system") { tgt = this._system[this._dragTarget.index!]; label = (this._system[this._dragTarget.index!] as any)?.label || ""; }
    if (tgt && label) {
      ctx.fillStyle = "rgba(56,189,248,0.5)";
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, (tgt.x + tgt.w / 2) * cw, (tgt.y + tgt.h / 2) * ch);
    }
  }

  // Edit mode banner
  if (this._showHandles) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, 0, cw, 24);
    ctx.fillStyle = "rgba(0,200,255,0.9)";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("Unlocked — drag zones or corner handles. Return to Controller Layout to lock.", 8, 12);
  }

  this._animId = this._reducedMotion ? null : requestAnimationFrame(this._render);
};

// ── Drawing helpers (inlined in _render) ──────────────────────────────────

function drawDpad(gp: TouchGamepad, ctx: CanvasRenderingContext2D, cw: number, ch: number) {
  const d = gp._dpad;
  const x = d.x * cw, y = d.y * ch, w = d.w * cw, h = d.h * ch;
  const cx = x + w / 2, cy = y + h / 2;
  const armW = w * 0.3, armH = h * 0.3;

  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath();
  ctx.roundRect(x, y + armH, w, h - armH * 2, 4);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(x + armW, y, w - armW * 2, h, 4);
  ctx.fill();

  const arms = [
    { x: cx - armW / 2, y: y, w: armW, h: armH, active: gp._dpadActive[0] },
    { x: cx - armW / 2, y: y + h - armH, w: armW, h: armH, active: gp._dpadActive[1] },
    { x: x, y: cy - armH / 2, w: armW, h: armH, active: gp._dpadActive[2] },
    { x: x + w - armW, y: cy - armH / 2, w: armW, h: armH, active: gp._dpadActive[3] },
  ];

  for (const arm of arms) {
    ctx.fillStyle = arm.active ? "rgba(56,189,248,0.45)" : "rgba(255,255,255,0.05)";
    ctx.beginPath();
    ctx.roundRect(arm.x, arm.y, arm.w, arm.h, 4);
    ctx.fill();
    ctx.strokeStyle = arm.active ? "rgba(56,189,248,0.5)" : "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawButton(ctx: CanvasRenderingContext2D, zone: ButtonZone, cw: number, ch: number, pressed: boolean, showHandles: boolean) {
  const x = zone.x * cw, y = zone.y * ch, w = zone.w * cw, h = zone.h * ch;
  ctx.fillStyle = pressed ? "rgba(56,189,248,0.4)" : "rgba(255,255,255,0.1)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 2);
  ctx.fill();
  ctx.strokeStyle = pressed ? "rgba(56,189,248,0.5)" : "rgba(255,255,255,0.15)";
  ctx.lineWidth = 2;
  ctx.stroke();
  if (showHandles) {
    ctx.strokeStyle = "rgba(255,200,50,0.5)";
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = pressed ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.55)";
  ctx.font = Math.floor(Math.min(w, h) * 0.42) + "px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(zone.label, x + w / 2, y + h / 2);
}

function drawResizeHandles(ctx: CanvasRenderingContext2D, d: NormalisedRect, cw: number, ch: number, visible: boolean = true) {
  if (!visible) return;
  const corners = [
    { x: d.x * cw, y: d.y * ch },
    { x: (d.x + d.w) * cw, y: d.y * ch },
    { x: d.x * cw, y: (d.y + d.h) * ch },
    { x: (d.x + d.w) * cw, y: (d.y + d.h) * ch },
  ];
  // 14px filled squares with sky-blue accent at 60% opacity —
  // large enough for fingers and clearly distinguishable from gameplay controls.
  const size = 14;
  ctx.fillStyle = "rgba(56,189,248,0.6)";
  for (const c of corners) {
    ctx.fillRect(c.x - size / 2, c.y - size / 2, size, size);
  }
}

// ── Tower of touch handlers ────────────────────────────────────────────────
// These are complex. They incorporate the domain logic directly since
// extracting them cleanly requires a more substantial refactor.

function handleStart(
  gp: TouchGamepad, t: Touch, cw: number, self: TouchGamepad
): boolean {
  const rect = gp._canvas!.getBoundingClientRect();
  const n = {
    x: (t.clientX - rect.left) / (rect.width || 1),
    y: (t.clientY - rect.top) / (rect.height || 1),
  };

  const preferredTarget = (t.target as HTMLElement | undefined)?.dataset?.touchTarget;
  const zone = (gp as any)._findTouchZone(n, preferredTarget);

  // Edit mode: resize or drag
  if (gp._showHandles && zone && zone.kind === "resize") {
    gp._dragTarget = { kind: "resize", zone: zone.zone, index: zone.index, tag: zone.tag };
    let tgt: NormalisedRect | null = null;
    if (zone.zone === "dpad") tgt = gp._dpad;
    else if (zone.zone === "face") tgt = gp._face[zone.index] || null;
    else if (zone.zone === "system") tgt = gp._system[zone.index] || null;
    if (tgt) {
      gp._dragStart = {
        fingerId: t.identifier,
        nx: n.x, ny: n.y,
        tx: tgt.x, ty: tgt.y, tw: tgt.w, th: tgt.h,
        mode: "resize",
      };
      (gp as any)._scheduleRender();
    }
    return false;
  }

  // Edit mode: zone drag
  if (gp._editMode && zone && zone.kind !== "resize") {
    const dragZone: DragTarget = zone.kind === "dpad"
      ? { kind: "move", zone: "dpad" }
      : { kind: "move", zone: zone.kind, index: Number.parseInt(zone.zone!, 10) };
    gp._dragTarget = dragZone;
    let tgt2: NormalisedRect | null = null;
    if (dragZone.zone === "dpad") tgt2 = gp._dpad;
    else if (dragZone.zone === "face") tgt2 = gp._face[dragZone.index!] || null;
    else if (dragZone.zone === "system") tgt2 = gp._system[dragZone.index!] || null;
    if (tgt2) {
      gp._dragStart = {
        fingerId: t.identifier,
        nx: n.x, ny: n.y,
        tx: tgt2.x, ty: tgt2.y, tw: tgt2.w, th: tgt2.h,
        mode: "move",
      };
      (gp as any)._scheduleRender();
    }
    return false;
  }

  // Locked mode: input
  if (!gp._editMode && zone) {
    applyInput(gp, zone, n);
  }
  return false;
}

function handleMove(
  gp: TouchGamepad, allTouches: TouchList
): void {
  if (!gp._canvas) return;
  const rect = gp._canvas.getBoundingClientRect();
  const cw = rect.width;

  if (gp._dragTarget && gp._dragStart) {
    const id = gp._dragStart.fingerId;
    for (let i = 0; i < allTouches.length; i++) {
      const t = allTouches[i];
      if (t.identifier !== id) continue;
      const n = {
        x: (t.clientX - rect.left) / (cw || 1),
        y: (t.clientY - rect.top) / (rect.height || 1),
      };
      const dx = n.x - gp._dragStart.nx;
      const dy = n.y - gp._dragStart.ny;
      let tgt: NormalisedRect | null = null;
      if (gp._dragTarget.zone === "dpad") tgt = gp._dpad;
      else if (gp._dragTarget.zone === "face") tgt = gp._face[gp._dragTarget.index!] || null;
      else if (gp._dragTarget.zone === "system") tgt = gp._system[gp._dragTarget.index!] || null;
      if (!tgt) return;

      if (gp._dragStart.mode === "resize") {
        const tag = gp._dragTarget.tag || "";
        if (tag.includes(":nw")) {
          tgt.x = gp._dragStart.tx + dx;
          tgt.y = gp._dragStart.ty + dy;
          tgt.w = gp._dragStart.tw - dx;
          tgt.h = gp._dragStart.th - dy;
        } else if (tag.includes(":ne")) {
          tgt.y = gp._dragStart.ty + dy;
          tgt.w = gp._dragStart.tw + dx;
          tgt.h = gp._dragStart.th - dy;
        } else if (tag.includes(":sw")) {
          tgt.x = gp._dragStart.tx + dx;
          tgt.w = gp._dragStart.tw - dx;
          tgt.h = gp._dragStart.th + dy;
        } else if (tag.includes(":se")) {
          tgt.w = gp._dragStart.tw + dx;
          tgt.h = gp._dragStart.th + dy;
        }
        const minW = 56 / (rect.width || 1);
        const minH = 56 / (rect.height || 1);
        const anchoredRight = gp._dragStart.tx + gp._dragStart.tw;
        const anchoredBottom = gp._dragStart.ty + gp._dragStart.th;
        if (tgt.w < minW) {
          tgt.w = minW;
          if (tag.includes(":nw") || tag.includes(":sw")) tgt.x = anchoredRight - minW;
        }
        if (tgt.h < minH) {
          tgt.h = minH;
          if (tag.includes(":nw") || tag.includes(":ne")) tgt.y = anchoredBottom - minH;
        }
        tgt.x = Math.max(0, Math.min(1 - tgt.w, tgt.x));
        tgt.y = Math.max(0, Math.min(1 - tgt.h, tgt.y));
        if (tgt.w !== gp._dragStart.tw || tgt.h !== gp._dragStart.th) {
          gp._sizePreset = "custom";
          saveSizePreset("custom");
        }
      } else {
        tgt.x = gp._dragStart.tx + dx;
        tgt.y = gp._dragStart.ty + dy;
        tgt.x = Math.max(0, Math.min(1 - tgt.w, tgt.x));
        tgt.y = Math.max(0, Math.min(1 - tgt.h, tgt.y));
      }
      (gp as any)._syncTouchIslands();
      (gp as any)._scheduleRender();
      return;
    }
    return;
  }

  // Locked mode: track active touches
  if (!gp._editMode) {
    (gp as any)._clearInputs();
    for (let j = 0; j < allTouches.length; j++) {
      const t2 = allTouches[j];
      const n2 = {
        x: (t2.clientX - rect.left) / (cw || 1),
        y: (t2.clientY - rect.top) / (rect.height || 1),
      };
      const z2 = (gp as any)._findTouchZone(n2);
      if (z2 && z2.kind !== "resize") {
        applyInput(gp, z2, n2);
      }
    }
    (gp as any)._emitState();
  }
}

function handleEnd(
  gp: TouchGamepad, changedTouches: TouchList, allTouches: TouchList
): void {
  if (!gp._canvas) return;
  const rect = gp._canvas.getBoundingClientRect();
  const cw = rect.width, ch = rect.height;

  // End drag
  if (gp._dragTarget && gp._dragStart) {
    for (let i = 0; i < changedTouches.length; i++) {
      if (changedTouches[i].identifier === gp._dragStart!.fingerId) {
        gp._dragTarget = null;
        gp._dragStart = null;
        (gp as any)._saveLayout();
        (gp as any)._syncTouchIslands();
        (gp as any)._scheduleRender();
        break;
      }
    }
  }

  // Recalculate inputs
  if (!gp._editMode) {
    (gp as any)._clearInputs();
    for (let m = 0; m < allTouches.length; m++) {
      const tm = allTouches[m];
      const nm = {
        x: (tm.clientX - rect.left) / (cw || 1),
        y: (tm.clientY - rect.top) / (ch || 1),
      };
      const zm = (gp as any)._findTouchZone(nm);
      if (zm && zm.kind !== "resize") {
        applyInput(gp, zm, nm);
      }
    }
    (gp as any)._emitState();
  }
}

function applyInput(
  gp: TouchGamepad,
  zone: { kind: string; zone?: string },
  n: { x: number; y: number }
): void {
  if (zone.kind === "dpad") {
    const d = gp._dpad;
    const cx = (n.x - d.x) / d.w;
    const cy = (n.y - d.y) / d.h;
    gp._dpadActive[0] = cy < 0.35 && cx > 0.25 && cx < 0.75;
    gp._dpadActive[1] = cy > 0.65 && cx > 0.25 && cx < 0.75;
    gp._dpadActive[2] = cx < 0.35 && cy > 0.25 && cy < 0.75;
    gp._dpadActive[3] = cx > 0.65 && cy > 0.25 && cy < 0.75;
  } else if (zone.kind === "face" && zone.zone !== undefined) {
    gp._faceStates[parseInt(zone.zone, 10)] = true;
  } else if (zone.kind === "system" && zone.zone !== undefined) {
    gp._systemStates[parseInt(zone.zone, 10)] = true;
  }
}

// Pointer Events are the sole input path for touch, mouse, and pen. Keeping one
// event model avoids compatibility touch events double-applying a press.
function pointerSample(e: PointerEvent, target: HTMLElement) {
  return { identifier: e.pointerId, clientX: e.clientX, clientY: e.clientY, target };
}

function activePointerList(gp: TouchGamepad): TouchList {
  return Array.from(gp._activePointers.values()) as unknown as TouchList;
}

TouchGamepad.prototype._onPointerDown = function (this: TouchGamepad, e: PointerEvent) {
  const target = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-touch-target]");
  if (!target || this._inputSuspended || this._blockedPointerIds.has(e.pointerId) || e.button !== 0) return;
  e.preventDefault();
  target.setPointerCapture?.(e.pointerId);
  const sample = pointerSample(e, target);
  this._activePointers.set(e.pointerId, sample);
  handleStart(this, sample as unknown as Touch, this._canvas?.width || 1, this);
  (this as any)._emitState();
  if (!this._editMode) (this as any)._scheduleRender();
};

TouchGamepad.prototype._onPointerMove = function (this: TouchGamepad, e: PointerEvent) {
  if (this._inputSuspended || this._blockedPointerIds.has(e.pointerId) || !this._activePointers.has(e.pointerId)) return;
  e.preventDefault();
  const previous = this._activePointers.get(e.pointerId)!;
  this._activePointers.set(e.pointerId, pointerSample(e, previous.target));
  handleMove(this, activePointerList(this));
  if (!this._editMode) (this as any)._scheduleRender();
};

TouchGamepad.prototype._onPointerUp = function (this: TouchGamepad, e: PointerEvent) {
  if (this._blockedPointerIds.delete(e.pointerId)) return;
  const sample = this._activePointers.get(e.pointerId);
  if (this._inputSuspended || !sample) return;
  e.preventDefault();
  sample.target.releasePointerCapture?.(e.pointerId);
  this._activePointers.delete(e.pointerId);
  handleEnd(this, [sample] as unknown as TouchList, activePointerList(this));
  if (!this._editMode) (this as any)._scheduleRender();
};

// ── Cast mode ──────────────────────────────────────────────────────────────

TouchGamepad.prototype.setCastMode = function (this: TouchGamepad, enabled: boolean) {
  this._castMode = enabled;
  if (this._visible) {
    (this as any)._resizeCanvas();
    (this as any)._scheduleRender();
  }
};

// ── Export ─────────────────────────────────────────────────────────────────

export { TouchGamepad };
