// ── Touch Gamepad — main class ─────────────────────────────────────────────

import type {
  NormalisedRect, ButtonZone, LayoutData, PresetName, Orientation,
  DragTarget, TouchGamepadOptions, InputCallback,
} from "./types";
import { PRESETS, computeDefaults } from "./presets";
import { saveToggleState, loadLayouts, saveLayouts } from "./utils";

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
  _activePointers: Map<number, { identifier: number; clientX: number; clientY: number; target: HTMLElement }>;
  _blockedPointerIds: Set<number>;
  _lockBtn: NormalisedRect;
  _closeBtn: NormalisedRect;
  _swapBtn: NormalisedRect;
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
  this._activePointers = new Map();
  this._blockedPointerIds = new Set();
  this._lockBtn = { x: 0.895, y: 0.04, w: 0.07, h: 0.07 };
  this._closeBtn = { x: 0.755, y: 0.04, w: 0.07, h: 0.07 };
  this._swapBtn = { x: 0.615, y: 0.04, w: 0.07, h: 0.07 };
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
  return window.screen.availWidth > window.screen.availHeight
    ? "horizontal"
    : "vertical";
}

function layoutKey(this: TouchGamepad): string {
  return this._preset + ":" + resolveOrientation(this._layoutName);
}

// ── Layout load/save ─────────────────────────────────────────────────────

(TouchGamepad.prototype as any)._loadLayout = function (this: TouchGamepad) {
  const orientation = resolveOrientation(this._layoutName);
  const key = this._preset + ":" + orientation;
  const stored = this._layouts[key] || null;
  const src = stored || computeDefaults(this._preset, orientation);

  this._dpad = { x: src.dpad.x, y: src.dpad.y, w: src.dpad.w, h: src.dpad.h };
  this._face = (src.face || []).map((b: any) => ({
    x: b.x, y: b.y, w: b.w, h: b.h, label: b.label || "",
  }));
  this._system = (src.system || []).map((b: any) => ({
    x: b.x, y: b.y, w: b.w, h: b.h, label: b.label || "",
  }));
  this._faceStates = new Array(this._face.length).fill(false);
  this._systemStates = new Array(this._system.length).fill(false);
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

// ── AB/XY swap ─────────────────────────────────────────────────────────────

TouchGamepad.prototype.swapAB = function (this: TouchGamepad) {
  if (this._face.length < 2) return;
  const swap = (f: ButtonZone[], i: number, j: number) => {
    const tmp = { x: f[i].x, y: f[i].y, w: f[i].w, h: f[i].h };
    f[i].x = f[j].x; f[i].y = f[j].y; f[i].w = f[j].w; f[i].h = f[j].h;
    f[j].x = tmp.x; f[j].y = tmp.y; f[j].w = tmp.w; f[j].h = tmp.h;
    const tmpL = f[i].label;
    f[i].label = f[j].label;
    f[j].label = tmpL;
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
  for (const kind of ["dpad", "face", "system", "utility"]) {
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
    utility: setIslandBounds(groups.utility, [this._closeBtn, this._lockBtn, ...(this._face.length >= 4 ? [this._swapBtn] : [])]),
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
  [this._closeBtn, this._lockBtn, ...(this._face.length >= 4 ? [this._swapBtn] : [])]
    .forEach((zone, i) => attachIfNeeded(groups.utility, target(groups.utility, zone, `utility-${i}`, bounds.utility)));
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
      position: "fixed", left: safeLeft, right: safeRight, top: "auto", bottom: safeBottom,
      width: `calc(100vw - ${safeLeft} - ${safeRight})`,
      height: `calc(50vh - ${safeTop} - ${safeBottom})`, zIndex: "10",
    });
    this._video.style.maxHeight = "50vh";
    this._video.style.objectFit = "contain";
    w = Math.round(window.innerWidth);
    h = Math.round(window.innerHeight * 0.5);
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
  if (this._islandLayer) {
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
  const RESIZE_RX = 28 / (canvasRect?.width || 1);
  const RESIZE_RY = 28 / (canvasRect?.height || 1);

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

// ── UI button hit tests ───────────────────────────────────────────────────

(TouchGamepad.prototype as any)._hitLockBtn = function (this: TouchGamepad, nx: number, ny: number) {
  const lb = this._lockBtn;
  return nx >= lb.x && nx <= lb.x + lb.w && ny >= lb.y && ny <= lb.y + lb.h;
};

(TouchGamepad.prototype as any)._hitCloseBtn = function (this: TouchGamepad, nx: number, ny: number) {
  const cb = this._closeBtn;
  return nx >= cb.x && nx <= cb.x + cb.w && ny >= cb.y && ny <= cb.y + cb.h;
};

(TouchGamepad.prototype as any)._hitSwapBtn = function (this: TouchGamepad, nx: number, ny: number) {
  if (this._face.length < 4) return false;
  const sb = this._swapBtn;
  return nx >= sb.x && nx <= sb.x + sb.w && ny >= sb.y && ny <= sb.y + sb.h;
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

  // Resize handles (edit mode)
  if (this._showHandles) {
    drawResizeHandles(ctx, this._dpad, cw, ch);
    for (let i = 0; i < this._face.length; i++) {
      drawResizeHandles(ctx, this._face[i], cw, ch);
    }
    for (let i = 0; i < this._system.length; i++) {
      drawResizeHandles(ctx, this._system[i], cw, ch);
    }
  }

  // Lock button
  {
    const lb = this._lockBtn;
    const lbx = lb.x * cw, lby = lb.y * ch, lbw = lb.w * cw, lbh = lb.h * ch;
    const lbr = Math.min(lbw, lbh) / 2;
    const lbcx = lbx + lbw / 2, lbcy = lby + lbh / 2;
    const isEdit = this._editMode;
    ctx.fillStyle = isEdit ? "rgba(255,120,60,0.55)" : "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.arc(lbcx, lbcy, lbr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = isEdit ? "rgba(255,140,80,0.5)" : "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = isEdit ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.35)";
    ctx.font = Math.floor(lbr * 1.1) + "px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(isEdit ? "🔓" : "🔒", lbcx, lbcy);
  }

  // Close button
  {
    const cb = this._closeBtn;
    const cbx = cb.x * cw, cby = cb.y * ch, cbw = cb.w * cw, cbh = cb.h * ch;
    const cbr = Math.min(cbw, cbh) / 2;
    const cbcx = cbx + cbw / 2, cbcy = cby + cbh / 2;
    ctx.fillStyle = "rgba(255,60,60,0.45)";
    ctx.beginPath();
    ctx.arc(cbcx, cbcy, cbr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,80,80,0.4)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = Math.floor(cbr * 1.0) + "px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("✕", cbcx, cbcy);
  }

  // Swap button (SNES only)
  if (this._face.length >= 4) {
    const sb = this._swapBtn;
    const sbx = sb.x * cw, sby = sb.y * ch, sbw = sb.w * cw, sbh = sb.h * ch;
    const sbr = Math.min(sbw, sbh) / 2;
    const sbcx = sbx + sbw / 2, sbcy = sby + sbh / 2;
    ctx.fillStyle = "rgba(56,189,248,0.4)";
    ctx.beginPath();
    ctx.arc(sbcx, sbcy, sbr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(56,189,248,0.35)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = Math.floor(sbr * 0.9) + "px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("↔", sbcx, sbcy);
  }

  // Edit mode banner
  if (this._showHandles) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, 0, cw, 24);
    ctx.fillStyle = "rgba(0,200,255,0.9)";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("Unlocked — drag zones, corner handles to resize. Tap 🔓 to lock.", 8, 12);
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

function drawResizeHandles(ctx: CanvasRenderingContext2D, d: NormalisedRect, cw: number, ch: number) {
  const corners = [
    { x: d.x * cw, y: d.y * ch },
    { x: (d.x + d.w) * cw, y: d.y * ch },
    { x: d.x * cw, y: (d.y + d.h) * ch },
    { x: (d.x + d.w) * cw, y: (d.y + d.h) * ch },
  ];
  ctx.fillStyle = "rgba(255,200,50,0.7)";
  for (const c of corners) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
    ctx.fill();
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

  // Lock
  if ((gp as any)._hitLockBtn(n.x, n.y)) {
    if (gp._editMode) (gp as any).exitEditMode();
    else (gp as any).enterEditMode();
    return false;
  }
  // Close
  if ((gp as any)._hitCloseBtn(n.x, n.y)) {
    (gp as any).hide();
    return false;
  }
  // Swap
  if ((gp as any)._hitSwapBtn(n.x, n.y)) {
    (gp as any).swapAB();
    return false;
  }

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
        if (tgt.w < 0.03) tgt.w = 0.03;
        if (tgt.h < 0.03) tgt.h = 0.03;
        tgt.x = Math.max(0, Math.min(1, tgt.x));
        tgt.y = Math.max(0, Math.min(1, tgt.y));
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
      if ((gp as any)._hitLockBtn(n2.x, n2.y)) continue;
      if ((gp as any)._hitCloseBtn(n2.x, n2.y)) continue;
      if ((gp as any)._hitSwapBtn(n2.x, n2.y)) continue;
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
  let completedDrag = false;
  if (gp._dragTarget && gp._dragStart) {
    for (let i = 0; i < changedTouches.length; i++) {
      if (changedTouches[i].identifier === gp._dragStart!.fingerId) {
        completedDrag = true;
        gp._dragTarget = null;
        gp._dragStart = null;
        (gp as any)._saveLayout();
        (gp as any)._syncTouchIslands();
        (gp as any)._scheduleRender();
        break;
      }
    }
  }

  // Unlocked: tap empty space → lock
  if (gp._editMode && !gp._dragTarget && !completedDrag) {
    for (let j = 0; j < changedTouches.length; j++) {
      const nn = {
        x: (changedTouches[j].clientX - rect.left) / (cw || 1),
        y: (changedTouches[j].clientY - rect.top) / (ch || 1),
      };
      if ((gp as any)._hitLockBtn(nn.x, nn.y)) continue;
      if ((gp as any)._hitCloseBtn(nn.x, nn.y)) continue;
      if ((gp as any)._hitSwapBtn(nn.x, nn.y)) continue;
      const zz = (gp as any)._findTouchZone(nn);
      if (!zz || zz.kind === "resize") {
        (gp as any).exitEditMode();
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
      if ((gp as any)._hitLockBtn(nm.x, nm.y)) continue;
      if ((gp as any)._hitCloseBtn(nm.x, nm.y)) continue;
      if ((gp as any)._hitSwapBtn(nm.x, nm.y)) continue;
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
