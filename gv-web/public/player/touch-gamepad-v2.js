"use strict";
var __touchGamepadBundle = (() => {
  // lib/touch-gamepad/presets.ts
  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }
  var PRESETS = {
    nes: {
      face: [{ label: "B" }, { label: "A" }],
      system: [{ label: "SELECT" }, { label: "START" }]
    },
    gamegear: {
      face: [{ label: "1" }, { label: "2" }],
      system: [{ label: "START" }]
    },
    genesis: {
      face: [{ label: "A" }, { label: "B" }, { label: "C" }],
      system: [{ label: "START" }]
    },
    arcade: {
      face: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }],
      system: [{ label: "COIN" }, { label: "START" }]
    },
    atari: {
      face: [{ label: "FIRE" }],
      system: [{ label: "SELECT" }, { label: "START" }]
    },
    snes: {
      face: [{ label: "B" }, { label: "A" }, { label: "Y" }, { label: "X" }],
      system: [{ label: "L" }, { label: "SELECT" }, { label: "START" }, { label: "R" }]
    }
  };
  function computeDefaults(preset, orientation) {
    const cfg = PRESETS[preset] || PRESETS.nes;
    const nFace = cfg.face.length;
    const nSys = cfg.system.length;
    const isHoriz = orientation === "horizontal" || orientation === "landscape";
    let dpad = { x: 0, y: 0, w: 0, h: 0 };
    const face = [];
    const system = [];
    if (isHoriz) {
      dpad = { x: 0.03, y: 0.48, w: 0.22, h: 0.46 };
      let cols, rows, bw, bh, gap;
      if (nFace === 3) {
        cols = 3;
        rows = 1;
        bw = 0.08;
        bh = 0.13;
        gap = 0.02;
      } else {
        cols = nFace <= 2 ? 2 : Math.min(nFace, 3);
        rows = Math.ceil(nFace / cols);
        bw = 0.1;
        bh = 0.12;
        gap = 0.015;
      }
      const gridW = cols * bw + (cols - 1) * gap;
      const gridH = rows * bh + (rows - 1) * gap;
      const startX = 0.97 - gridW;
      const startY = 0.94 - gridH;
      for (let fi = 0; fi < nFace; fi++) {
        const col = fi % cols;
        const row = Math.floor(fi / cols);
        face.push({
          x: clamp(startX + col * (bw + gap), 0, 1),
          y: clamp(startY + row * (bh + gap), 0, 1),
          w: bw,
          h: bh,
          label: cfg.face[fi].label
        });
      }
      const sw = 0.09, sh = 0.05, sGap = 0.02;
      const sysW = nSys * sw + (nSys - 1) * sGap;
      const sysX = 0.5 - sysW / 2;
      const sysY = 0.92;
      for (let si = 0; si < nSys; si++) {
        system.push({
          x: sysX + si * (sw + sGap),
          y: sysY,
          w: sw,
          h: sh,
          label: cfg.system[si].label
        });
      }
    } else {
      dpad = { x: 0.03, y: 0.08, w: 0.24, h: 0.52 };
      const vcols = Math.min(2, nFace);
      const vrows = Math.ceil(nFace / vcols);
      const vbw = 0.12, vbh = 0.16, vgap = 0.03;
      const faceW = vcols * vbw + (vcols - 1) * vgap;
      const faceH = vrows * vbh + (vrows - 1) * vgap;
      const faceX = 0.97 - faceW;
      const faceY = (0.72 - faceH) / 2;
      for (let vfi = 0; vfi < nFace; vfi++) {
        const col = vfi % vcols;
        const row = Math.floor(vfi / vcols);
        face.push({
          x: faceX + col * (vbw + vgap),
          y: faceY + row * (vbh + vgap),
          w: vbw,
          h: vbh,
          label: cfg.face[vfi].label
        });
      }
      const vsw = 0.12, vsh = 0.12, vsGap = 0.02;
      const sysW2 = nSys * vsw + (nSys - 1) * vsGap;
      const sysX2 = 0.5 - sysW2 / 2;
      const sysY2 = 0.8;
      for (let vsi = 0; vsi < nSys; vsi++) {
        system.push({
          x: sysX2 + vsi * (vsw + vsGap),
          y: sysY2,
          w: vsw,
          h: vsh,
          label: cfg.system[vsi].label
        });
      }
    }
    if (!isHoriz) {
      const toFullShell = (rect) => ({
        ...rect,
        y: 0.5 + rect.y * 0.5,
        h: rect.h * 0.5
      });
      dpad = toFullShell(dpad);
      return {
        dpad,
        face: face.map(toFullShell),
        system: system.map(toFullShell)
      };
    }
    return { dpad, face, system };
  }

  // lib/touch-gamepad/utils.ts
  var PERSIST_KEY = "gv:touch-layouts-v3";
  var LEGACY_PERSIST_KEY = "gv:touch-layouts-v2";
  var TOGGLE_KEY = "gv:touch-visible";
  var OPACITY_KEY = "gv:touch-opacity";
  var SIZE_PRESET_KEY = "gv:touch-size-preset";
  function parseLayouts(value) {
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return null;
    }
  }
  function migrateVerticalRect(rect) {
    if (!rect || typeof rect !== "object") return rect;
    const value = rect;
    return {
      ...value,
      ...typeof value.y === "number" ? { y: 0.5 + value.y * 0.5 } : {},
      ...typeof value.h === "number" ? { h: value.h * 0.5 } : {}
    };
  }
  function migrateV2Layouts(layouts) {
    return Object.fromEntries(Object.entries(layouts).map(([key, layout]) => {
      if (!key.endsWith(":vertical") || !layout || typeof layout !== "object") {
        return [key, layout];
      }
      return [key, {
        ...layout,
        dpad: migrateVerticalRect(layout.dpad),
        face: Array.isArray(layout.face) ? layout.face.map(migrateVerticalRect) : layout.face,
        system: Array.isArray(layout.system) ? layout.system.map(migrateVerticalRect) : layout.system
      }];
    }));
  }
  function loadLayouts() {
    let currentValue;
    let legacyValue;
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
      }
    }
    return migrated;
  }
  function saveLayouts(data) {
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(data));
    } catch {
    }
  }
  function saveToggleState(visible) {
    try {
      localStorage.setItem(TOGGLE_KEY, visible ? "1" : "0");
    } catch {
    }
  }
  function loadOpacity() {
    try {
      const value = localStorage.getItem(OPACITY_KEY);
      return value === "low" || value === "high" || value === "max" ? value : "medium";
    } catch {
      return "medium";
    }
  }
  function saveOpacity(opacity) {
    try {
      localStorage.setItem(OPACITY_KEY, opacity);
    } catch {
    }
  }
  function loadSizePreset() {
    try {
      const value = localStorage.getItem(SIZE_PRESET_KEY);
      return value === "compact" || value === "large" || value === "custom" ? value : "standard";
    } catch {
      return "standard";
    }
  }
  function saveSizePreset(size) {
    try {
      localStorage.setItem(SIZE_PRESET_KEY, size);
    } catch {
    }
  }

  // lib/touch-gamepad/index.ts
  function TouchGamepad(video, opts) {
    opts = opts || {};
    this._video = video;
    this._preset = opts.preset || "nes";
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
    this._reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this._animId = null;
    this._dragTarget = null;
    this._dragStart = null;
    this._editMode = false;
    this._showHandles = false;
    this._opacity = loadOpacity();
    this._sizePreset = loadSizePreset();
    this._activePointers = /* @__PURE__ */ new Map();
    this._blockedPointerIds = /* @__PURE__ */ new Set();
    this.onInput = null;
    this._castMode = false;
    this._layouts = loadLayouts();
    this._loadLayout();
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onOrientationChange = this._onOrientationChange.bind(this);
    this._render = this._render.bind(this);
  }
  function resolveOrientation(layoutName) {
    if (layoutName === "horizontal") return "horizontal";
    if (layoutName === "vertical") return "vertical";
    if (!window.screen) return "vertical";
    return window.screen.availWidth > window.screen.availHeight ? "horizontal" : "vertical";
  }
  function layoutKey() {
    return this._preset + ":" + resolveOrientation(this._layoutName);
  }
  TouchGamepad.prototype._loadLayout = function() {
    const orientation = resolveOrientation(this._layoutName);
    const key = this._preset + ":" + orientation;
    const stored = this._layouts[key] || null;
    const defaults = computeDefaults(this._preset, orientation);
    const expected = PRESETS[this._preset] || PRESETS.nes;
    const labelsMatch = (group, config) => Array.isArray(group) && group.length === config.length && group.every((button, index) => button?.label === config[index].label);
    const dpad = stored?.dpad || defaults.dpad;
    const face = stored && labelsMatch(stored.face, expected.face) ? stored.face : defaults.face;
    const system = stored && labelsMatch(stored.system, expected.system) ? stored.system : defaults.system;
    const migrated = stored && (face !== stored.face || system !== stored.system);
    const src = { dpad, face, system };
    this._dpad = { x: src.dpad.x, y: src.dpad.y, w: src.dpad.w, h: src.dpad.h };
    this._face = src.face.map((b) => ({
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      label: b.label || ""
    }));
    this._system = src.system.map((b) => ({
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      label: b.label || ""
    }));
    this._faceStates = new Array(this._face.length).fill(false);
    this._systemStates = new Array(this._system.length).fill(false);
    if (migrated) {
      this._layouts[key] = {
        dpad: { ...this._dpad },
        face: this._face.map((button) => ({ ...button })),
        system: this._system.map((button) => ({ ...button }))
      };
      saveLayouts(this._layouts);
    }
  };
  TouchGamepad.prototype._saveLayout = function() {
    const key = layoutKey.call(this);
    this._layouts[key] = {
      dpad: { x: this._dpad.x, y: this._dpad.y, w: this._dpad.w, h: this._dpad.h },
      face: this._face.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, label: b.label })),
      system: this._system.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, label: b.label }))
    };
    saveLayouts(this._layouts);
  };
  TouchGamepad.prototype.setPreset = function(preset) {
    if (!PRESETS[preset]) return;
    this._preset = preset;
    this._loadLayout();
    this._syncTouchIslands();
    if (this._visible) {
      this._resizeCanvas();
      this._scheduleRender();
    }
  };
  TouchGamepad.prototype.setLayout = function(layout) {
    this._layoutName = layout;
    this._loadLayout();
    this._syncTouchIslands();
    if (this._visible) {
      this._resizeCanvas();
      this._scheduleRender();
    }
  };
  TouchGamepad.prototype.enterEditMode = function() {
    this._editMode = true;
    this._showHandles = true;
    this._scheduleRender();
  };
  TouchGamepad.prototype.exitEditMode = function() {
    this._editMode = false;
    this._showHandles = false;
    this._saveLayout();
    this._syncTouchIslands();
    this._scheduleRender();
  };
  TouchGamepad.prototype.setOpacity = function(opacity) {
    if (opacity !== "low" && opacity !== "medium" && opacity !== "high" && opacity !== "max") return;
    this._opacity = opacity;
    saveOpacity(opacity);
    if (this._canvas) this._canvas.style.opacity = String({ low: 0.35, medium: 0.55, high: 0.8, max: 0.95 }[opacity]);
  };
  TouchGamepad.prototype.getOpacity = function() {
    return this._opacity;
  };
  TouchGamepad.prototype.setSizePreset = function(size) {
    const scale = { compact: 0.85, standard: 1, large: 1.2 }[size];
    if (!scale) return;
    this._sizePreset = size;
    saveSizePreset(size);
    const defaults = computeDefaults(this._preset, resolveOrientation(this._layoutName));
    const resizeAroundCenter = (zone, defaultZone) => {
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
    if (this._visible) this._resizeCanvas();
    this._saveLayout();
    this._syncTouchIslands();
    this._scheduleRender();
  };
  TouchGamepad.prototype.getSizePreset = function() {
    return this._sizePreset;
  };
  TouchGamepad.prototype.resetLayout = function() {
    delete this._layouts[layoutKey.call(this)];
    saveLayouts(this._layouts);
    this._loadLayout();
    this._sizePreset = "standard";
    saveSizePreset("standard");
    if (this._visible) this._resizeCanvas();
    this._syncTouchIslands();
    this._scheduleRender();
  };
  TouchGamepad.prototype.swapAB = function() {
    if (this._face.length < 2) return;
    const swap = (f, i, j) => {
      const tmp = { x: f[i].x, y: f[i].y, w: f[i].w, h: f[i].h };
      f[i].x = f[j].x;
      f[i].y = f[j].y;
      f[i].w = f[j].w;
      f[i].h = f[j].h;
      f[j].x = tmp.x;
      f[j].y = tmp.y;
      f[j].w = tmp.w;
      f[j].h = tmp.h;
    };
    swap(this._face, 0, 1);
    if (this._face.length >= 4) swap(this._face, 2, 3);
    this._saveLayout();
    this._syncTouchIslands();
    if (this._visible) this._scheduleRender();
  };
  TouchGamepad.prototype.show = function() {
    if (this._visible) return;
    this._visible = true;
    this._ensureCanvas();
    if (this._islandLayer) this._islandLayer.style.display = "block";
    if (this._layoutName === "auto") {
      window.addEventListener("orientationchange", this._onOrientationChange);
    }
    this._resizeCanvas();
    this._scheduleRender();
    saveToggleState(true);
  };
  TouchGamepad.prototype.hide = function() {
    this._visible = false;
    if (this._canvas) this._canvas.style.display = "none";
    if (this._islandLayer) this._islandLayer.style.display = "none";
    if (this._animId) {
      cancelAnimationFrame(this._animId);
      this._animId = null;
    }
    this._video.style.maxHeight = "";
    this._video.style.objectFit = "";
    this._clearInputs();
    this._dragTarget = null;
    this._dragStart = null;
    this._activePointers.forEach((pointer, id) => pointer.target.releasePointerCapture?.(id));
    this._activePointers.clear();
    this._blockedPointerIds.clear();
    this._emitState();
    if (this._layoutName === "auto") {
      window.removeEventListener("orientationchange", this._onOrientationChange);
    }
    saveToggleState(false);
  };
  TouchGamepad.prototype.suspendInput = function() {
    this._inputSuspended = true;
    if (this._canvas) this._canvas.style.filter = "brightness(0.45)";
    this._activePointers.forEach((pointer, id) => {
      this._blockedPointerIds.add(id);
      pointer.target.releasePointerCapture?.(id);
    });
    if (this._islandLayer) {
      this._islandLayer.querySelectorAll("[data-touch-target]").forEach((target) => {
        target.style.pointerEvents = "none";
      });
    }
    this._clearInputs();
    this._dragTarget = null;
    this._dragStart = null;
    this._activePointers.clear();
    this._emitState();
  };
  TouchGamepad.prototype.resumeInput = function() {
    this._inputSuspended = false;
    if (this._canvas) this._canvas.style.filter = "";
    this._blockedPointerIds.clear();
    if (this._islandLayer) {
      this._islandLayer.querySelectorAll("[data-touch-target]").forEach((target) => {
        target.style.pointerEvents = "auto";
      });
    }
  };
  TouchGamepad.prototype.toggle = function() {
    if (this._visible) TouchGamepad.prototype.hide.call(this);
    else TouchGamepad.prototype.show.call(this);
  };
  TouchGamepad.prototype.isVisible = function() {
    return this._visible;
  };
  TouchGamepad.prototype.destroy = function() {
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
  TouchGamepad.prototype._ensureCanvas = function() {
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
    const parent = this._video.parentNode;
    if (parent && getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent.appendChild(c);
    this._canvas = c;
    this._ctx = c.getContext("2d");
    const layer = document.createElement("div");
    layer.dataset.touchIslands = "";
    Object.assign(layer.style, {
      position: "absolute",
      pointerEvents: "none",
      touchAction: "none",
      zIndex: "11",
      boxSizing: "border-box"
    });
    for (const kind of ["dpad", "face", "system"]) {
      const island = document.createElement("div");
      island.dataset.touchIsland = kind;
      island.setAttribute("role", "group");
      island.setAttribute("aria-label", `${kind} touch controls`);
      Object.assign(island.style, { position: "absolute", inset: "0", pointerEvents: "none", touchAction: "none" });
      layer.appendChild(island);
    }
    parent.appendChild(layer);
    this._islandLayer = layer;
    this._syncTouchIslands();
    layer.addEventListener("pointerdown", this._onPointerDown);
    layer.addEventListener("pointermove", this._onPointerMove);
    layer.addEventListener("pointerup", this._onPointerUp);
    layer.addEventListener("pointercancel", this._onPointerUp);
  };
  TouchGamepad.prototype._syncTouchIslands = function() {
    if (!this._islandLayer) return;
    const groups = Object.fromEntries(Array.from(this._islandLayer.children).map((el) => [
      el.dataset.touchIsland,
      el
    ]));
    const setIslandBounds = (group, rects) => {
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
      system: setIslandBounds(groups.system, this._system)
    };
    const desiredTargets = /* @__PURE__ */ new Set();
    const target = (group, rect, label, _bound) => {
      desiredTargets.add(label);
      const el = group.querySelector(`[data-touch-target="${label}"]`) ?? document.createElement("span");
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
        minWidth: "44px",
        minHeight: "44px",
        boxSizing: "border-box",
        borderStyle: "solid",
        borderWidth: "2px",
        borderColor: "transparent",
        pointerEvents: this._inputSuspended ? "none" : "auto"
      });
      return el;
    };
    const attachIfNeeded = (group, el) => {
      if (el.parentElement !== group) group.appendChild(el);
    };
    attachIfNeeded(groups.dpad, target(groups.dpad, this._dpad, "dpad", bounds.dpad));
    this._face.forEach((zone, i) => attachIfNeeded(groups.face, target(groups.face, zone, `face-${i}`, bounds.face)));
    this._system.forEach((zone, i) => attachIfNeeded(groups.system, target(groups.system, zone, `system-${i}`, bounds.system)));
    this._islandLayer.querySelectorAll("[data-touch-target]").forEach((el) => {
      if (!desiredTargets.has(el.dataset.touchTarget)) el.remove();
    });
  };
  TouchGamepad.prototype._resizeCanvas = function() {
    if (!this._canvas) return;
    const orientation = resolveOrientation(this._layoutName);
    let w, h;
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
        position: "fixed",
        left: safeLeft,
        right: safeRight,
        top: safeTop,
        bottom: safeBottom,
        width: `calc(100vw - ${safeLeft} - ${safeRight})`,
        height: `calc(100vh - ${safeTop} - ${safeBottom})`,
        zIndex: "20"
      });
      w = Math.round(window.innerWidth);
      h = Math.round(window.innerHeight);
    } else if (orientation === "vertical") {
      Object.assign(this._canvas.style, {
        position: "fixed",
        left: "var(--touch-safe-left, 0px)",
        right: "var(--touch-safe-right, 0px)",
        top: "var(--touch-safe-top, 0px)",
        bottom: "var(--touch-safe-bottom, 0px)",
        width: "calc(100vw - var(--touch-safe-left, 0px) - var(--touch-safe-right, 0px))",
        height: "calc(100vh - var(--touch-safe-top, 0px) - var(--touch-safe-bottom, 0px))",
        zIndex: "10"
      });
      this._video.style.maxHeight = "50vh";
      this._video.style.objectFit = "contain";
      w = Math.round(window.innerWidth);
      h = Math.round(window.innerHeight);
    } else {
      const vr = this._video.getBoundingClientRect();
      const pr = this._canvas.parentNode.getBoundingClientRect();
      w = Math.round(vr.width);
      h = Math.round(vr.height);
      Object.assign(this._canvas.style, {
        position: "absolute",
        left: `calc(${vr.left - pr.left}px + ${safeLeft})`,
        right: safeRight,
        top: `calc(${vr.top - pr.top}px + ${safeTop})`,
        bottom: safeBottom,
        width: `calc(${w}px - ${safeLeft} - ${safeRight})`,
        height: `calc(${h}px - ${safeTop} - ${safeBottom})`,
        zIndex: "10"
      });
      this._video.style.maxHeight = "";
      this._video.style.objectFit = "";
    }
    if (w !== this._canvas.width || h !== this._canvas.height) {
      this._canvas.width = w;
      this._canvas.height = h;
    }
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
          this._canvas.style.getPropertyValue(`--touch-safe-${edge}`)
        );
      }
      Object.assign(this._islandLayer.style, {
        position: this._canvas.style.position,
        left: this._canvas.style.left,
        right: this._canvas.style.right,
        top: this._canvas.style.top,
        bottom: this._canvas.style.bottom,
        width: this._canvas.style.width,
        height: this._canvas.style.height
      });
      this._syncTouchIslands();
    }
  };
  TouchGamepad.prototype._scheduleRender = function() {
    if (!this._animId) {
      this._animId = requestAnimationFrame(this._render);
    }
  };
  TouchGamepad.prototype._onOrientationChange = function() {
    if (!this._visible) return;
    this._dragTarget = null;
    this._dragStart = null;
    this._activePointers.forEach((pointer, id) => pointer.target.releasePointerCapture?.(id));
    this._activePointers.clear();
    this._clearInputs();
    this._emitState();
    const self = this;
    setTimeout(() => {
      self._loadLayout();
      self._resizeCanvas();
    }, 200);
  };
  TouchGamepad.prototype._findTouchZone = function(n, preferredTarget) {
    const nx = n.x, ny = n.y;
    const canvasRect = this._canvas?.getBoundingClientRect();
    const RESIZE_RX = 56 / (canvasRect?.width || 1);
    const RESIZE_RY = 56 / (canvasRect?.height || 1);
    if (this._showHandles) {
      const d = this._dpad;
      const corners = [
        { x: d.x, y: d.y, tag: "resize:dpad:nw" },
        { x: d.x + d.w, y: d.y, tag: "resize:dpad:ne" },
        { x: d.x, y: d.y + d.h, tag: "resize:dpad:sw" },
        { x: d.x + d.w, y: d.y + d.h, tag: "resize:dpad:se" }
      ];
      for (const c of corners) {
        if (preferredTarget && preferredTarget !== "dpad") continue;
        if (Math.abs(nx - c.x) < RESIZE_RX && Math.abs(ny - c.y) < RESIZE_RY) {
          return { kind: "resize", zone: "dpad", tag: c.tag };
        }
      }
      for (const [zoneName, zones] of [["face", this._face], ["system", this._system]]) {
        for (let i = 0; i < zones.length; i++) {
          if (preferredTarget && preferredTarget !== `${zoneName}-${i}`) continue;
          const button = zones[i];
          const corners2 = [
            { x: button.x, y: button.y, tag: "nw" },
            { x: button.x + button.w, y: button.y, tag: "ne" },
            { x: button.x, y: button.y + button.h, tag: "sw" },
            { x: button.x + button.w, y: button.y + button.h, tag: "se" }
          ];
          for (const corner of corners2) {
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
  TouchGamepad.prototype._clearInputs = function() {
    this._dpadActive = [false, false, false, false];
    this._faceStates = this._faceStates.map(() => false);
    this._systemStates = this._systemStates.map(() => false);
  };
  TouchGamepad.prototype._emitState = function() {
    if (this.onInput) {
      this.onInput({
        dpad: this._dpadActive,
        face: this._faceStates,
        system: this._systemStates
      });
    }
  };
  TouchGamepad.prototype._render = function() {
    const canvas = this._canvas;
    if (!canvas || !this._ctx) return;
    const ctx = this._ctx;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    drawDpad(this, ctx, cw, ch);
    for (let i = 0; i < this._face.length; i++) {
      drawButton(ctx, this._face[i], cw, ch, this._faceStates[i], this._editMode || this._showHandles);
    }
    for (let i = 0; i < this._system.length; i++) {
      drawButton(ctx, this._system[i], cw, ch, this._systemStates[i], this._editMode || this._showHandles);
    }
    if (this._showHandles) {
      const isDragging = !!this._dragTarget;
      const dragZone = this._dragTarget?.zone;
      const dragIndex = this._dragTarget?.index;
      const showDpad = !isDragging || dragZone === "dpad";
      drawResizeHandles(ctx, this._dpad, cw, ch, showDpad);
      for (let i = 0; i < this._face.length; i++) {
        const showFace = !isDragging || dragZone === "face" && dragIndex === i;
        drawResizeHandles(ctx, this._face[i], cw, ch, showFace);
      }
      for (let i = 0; i < this._system.length; i++) {
        const showSys = !isDragging || dragZone === "system" && dragIndex === i;
        drawResizeHandles(ctx, this._system[i], cw, ch, showSys);
      }
    }
    if (this._dragTarget) {
      let tgt = null;
      let label = "";
      if (this._dragTarget.zone === "dpad") {
        tgt = this._dpad;
        label = "DPAD";
      } else if (this._dragTarget.zone === "face") {
        tgt = this._face[this._dragTarget.index];
        label = this._face[this._dragTarget.index]?.label || "";
      } else if (this._dragTarget.zone === "system") {
        tgt = this._system[this._dragTarget.index];
        label = this._system[this._dragTarget.index]?.label || "";
      }
      if (tgt && label) {
        ctx.fillStyle = "rgba(56,189,248,0.5)";
        ctx.font = "bold 16px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, (tgt.x + tgt.w / 2) * cw, (tgt.y + tgt.h / 2) * ch);
      }
    }
    if (this._showHandles) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, cw, 24);
      ctx.fillStyle = "rgba(0,200,255,0.9)";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("Unlocked \u2014 drag zones or corner handles. Return to Controller Layout to lock.", 8, 12);
    }
    this._animId = this._reducedMotion ? null : requestAnimationFrame(this._render);
  };
  function drawDpad(gp, ctx, cw, ch) {
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
      { x: cx - armW / 2, y, w: armW, h: armH, active: gp._dpadActive[0] },
      { x: cx - armW / 2, y: y + h - armH, w: armW, h: armH, active: gp._dpadActive[1] },
      { x, y: cy - armH / 2, w: armW, h: armH, active: gp._dpadActive[2] },
      { x: x + w - armW, y: cy - armH / 2, w: armW, h: armH, active: gp._dpadActive[3] }
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
  function drawButton(ctx, zone, cw, ch, pressed, showHandles) {
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
  function drawResizeHandles(ctx, d, cw, ch, visible = true) {
    if (!visible) return;
    const corners = [
      { x: d.x * cw, y: d.y * ch },
      { x: (d.x + d.w) * cw, y: d.y * ch },
      { x: d.x * cw, y: (d.y + d.h) * ch },
      { x: (d.x + d.w) * cw, y: (d.y + d.h) * ch }
    ];
    const size = 14;
    ctx.fillStyle = "rgba(56,189,248,0.6)";
    for (const c of corners) {
      ctx.fillRect(c.x - size / 2, c.y - size / 2, size, size);
    }
  }
  function handleStart(gp, t, cw, self) {
    const rect = gp._canvas.getBoundingClientRect();
    const n = {
      x: (t.clientX - rect.left) / (rect.width || 1),
      y: (t.clientY - rect.top) / (rect.height || 1)
    };
    const preferredTarget = t.target?.dataset?.touchTarget;
    const zone = gp._findTouchZone(n, preferredTarget);
    if (gp._showHandles && zone && zone.kind === "resize") {
      gp._dragTarget = { kind: "resize", zone: zone.zone, index: zone.index, tag: zone.tag };
      let tgt = null;
      if (zone.zone === "dpad") tgt = gp._dpad;
      else if (zone.zone === "face") tgt = gp._face[zone.index] || null;
      else if (zone.zone === "system") tgt = gp._system[zone.index] || null;
      if (tgt) {
        gp._dragStart = {
          fingerId: t.identifier,
          nx: n.x,
          ny: n.y,
          tx: tgt.x,
          ty: tgt.y,
          tw: tgt.w,
          th: tgt.h,
          mode: "resize"
        };
        gp._scheduleRender();
      }
      return false;
    }
    if (gp._editMode && zone && zone.kind !== "resize") {
      const dragZone = zone.kind === "dpad" ? { kind: "move", zone: "dpad" } : { kind: "move", zone: zone.kind, index: Number.parseInt(zone.zone, 10) };
      gp._dragTarget = dragZone;
      let tgt2 = null;
      if (dragZone.zone === "dpad") tgt2 = gp._dpad;
      else if (dragZone.zone === "face") tgt2 = gp._face[dragZone.index] || null;
      else if (dragZone.zone === "system") tgt2 = gp._system[dragZone.index] || null;
      if (tgt2) {
        gp._dragStart = {
          fingerId: t.identifier,
          nx: n.x,
          ny: n.y,
          tx: tgt2.x,
          ty: tgt2.y,
          tw: tgt2.w,
          th: tgt2.h,
          mode: "move"
        };
        gp._scheduleRender();
      }
      return false;
    }
    if (!gp._editMode && zone) {
      applyInput(gp, zone, n);
    }
    return false;
  }
  function handleMove(gp, allTouches) {
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
          y: (t.clientY - rect.top) / (rect.height || 1)
        };
        const dx = n.x - gp._dragStart.nx;
        const dy = n.y - gp._dragStart.ny;
        let tgt = null;
        if (gp._dragTarget.zone === "dpad") tgt = gp._dpad;
        else if (gp._dragTarget.zone === "face") tgt = gp._face[gp._dragTarget.index] || null;
        else if (gp._dragTarget.zone === "system") tgt = gp._system[gp._dragTarget.index] || null;
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
        gp._syncTouchIslands();
        gp._scheduleRender();
        return;
      }
      return;
    }
    if (!gp._editMode) {
      gp._clearInputs();
      for (let j = 0; j < allTouches.length; j++) {
        const t2 = allTouches[j];
        const n2 = {
          x: (t2.clientX - rect.left) / (cw || 1),
          y: (t2.clientY - rect.top) / (rect.height || 1)
        };
        const z2 = gp._findTouchZone(n2);
        if (z2 && z2.kind !== "resize") {
          applyInput(gp, z2, n2);
        }
      }
      gp._emitState();
    }
  }
  function handleEnd(gp, changedTouches, allTouches) {
    if (!gp._canvas) return;
    const rect = gp._canvas.getBoundingClientRect();
    const cw = rect.width, ch = rect.height;
    if (gp._dragTarget && gp._dragStart) {
      for (let i = 0; i < changedTouches.length; i++) {
        if (changedTouches[i].identifier === gp._dragStart.fingerId) {
          gp._dragTarget = null;
          gp._dragStart = null;
          gp._saveLayout();
          gp._syncTouchIslands();
          gp._scheduleRender();
          break;
        }
      }
    }
    if (!gp._editMode) {
      gp._clearInputs();
      for (let m = 0; m < allTouches.length; m++) {
        const tm = allTouches[m];
        const nm = {
          x: (tm.clientX - rect.left) / (cw || 1),
          y: (tm.clientY - rect.top) / (ch || 1)
        };
        const zm = gp._findTouchZone(nm);
        if (zm && zm.kind !== "resize") {
          applyInput(gp, zm, nm);
        }
      }
      gp._emitState();
    }
  }
  function applyInput(gp, zone, n) {
    if (zone.kind === "dpad") {
      const d = gp._dpad;
      const cx = (n.x - d.x) / d.w;
      const cy = (n.y - d.y) / d.h;
      gp._dpadActive[0] = cy < 0.35 && cx > 0.25 && cx < 0.75;
      gp._dpadActive[1] = cy > 0.65 && cx > 0.25 && cx < 0.75;
      gp._dpadActive[2] = cx < 0.35 && cy > 0.25 && cy < 0.75;
      gp._dpadActive[3] = cx > 0.65 && cy > 0.25 && cy < 0.75;
    } else if (zone.kind === "face" && zone.zone !== void 0) {
      gp._faceStates[parseInt(zone.zone, 10)] = true;
    } else if (zone.kind === "system" && zone.zone !== void 0) {
      gp._systemStates[parseInt(zone.zone, 10)] = true;
    }
  }
  function pointerSample(e, target) {
    return { identifier: e.pointerId, clientX: e.clientX, clientY: e.clientY, target };
  }
  function activePointerList(gp) {
    return Array.from(gp._activePointers.values());
  }
  TouchGamepad.prototype._onPointerDown = function(e) {
    const target = e.target?.closest("[data-touch-target]");
    if (!target || this._inputSuspended || this._blockedPointerIds.has(e.pointerId) || e.button !== 0) return;
    e.preventDefault();
    target.setPointerCapture?.(e.pointerId);
    const sample = pointerSample(e, target);
    this._activePointers.set(e.pointerId, sample);
    handleStart(this, sample, this._canvas?.width || 1, this);
    this._emitState();
    if (!this._editMode) this._scheduleRender();
  };
  TouchGamepad.prototype._onPointerMove = function(e) {
    if (this._inputSuspended || this._blockedPointerIds.has(e.pointerId) || !this._activePointers.has(e.pointerId)) return;
    e.preventDefault();
    const previous = this._activePointers.get(e.pointerId);
    this._activePointers.set(e.pointerId, pointerSample(e, previous.target));
    handleMove(this, activePointerList(this));
    if (!this._editMode) this._scheduleRender();
  };
  TouchGamepad.prototype._onPointerUp = function(e) {
    if (this._blockedPointerIds.delete(e.pointerId)) return;
    const sample = this._activePointers.get(e.pointerId);
    if (this._inputSuspended || !sample) return;
    e.preventDefault();
    sample.target.releasePointerCapture?.(e.pointerId);
    this._activePointers.delete(e.pointerId);
    handleEnd(this, [sample], activePointerList(this));
    if (!this._editMode) this._scheduleRender();
  };
  TouchGamepad.prototype.setCastMode = function(enabled) {
    this._castMode = enabled;
    if (this._visible) {
      this._resizeCanvas();
      this._scheduleRender();
    }
  };

  // lib/touch-gamepad/main.ts
  window.TouchGamepad = TouchGamepad;
  function bootstrap() {
    const video = document.querySelector(
      "video[data-gv-preset]"
    );
    if (!video) {
      requestAnimationFrame(bootstrap);
      return;
    }
    if (window.__gvTouchGamepad) return;
    const preset = video.dataset.gvPreset || "nes";
    const layout = video.dataset.gvLayout || "auto";
    const gp = new TouchGamepad(video, { preset, layout });
    window.__gvTouchGamepad = gp;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(bootstrap));
  } else {
    requestAnimationFrame(bootstrap);
  }
})();
