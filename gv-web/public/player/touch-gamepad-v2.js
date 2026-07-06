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
      system: [{ label: "SELECT" }, { label: "START" }]
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
      const vbw = 0.12, vbh = 0.16, vgap = 0.03;
      const faceW = nFace * vbw + (nFace - 1) * vgap;
      const faceX = 0.5 - faceW / 2;
      const faceY = (1 - vbh) / 2;
      for (let vfi = 0; vfi < nFace; vfi++) {
        face.push({
          x: faceX + vfi * (vbw + vgap),
          y: faceY,
          w: vbw,
          h: vbh,
          label: cfg.face[vfi].label
        });
      }
      const vsw = 0.09, vsh = 0.05, vsGap = 0.015;
      const sysW2 = nSys * vsw + (nSys - 1) * vsGap;
      const sysX2 = 0.97 - sysW2;
      const sysY2 = (1 - vsh) / 2;
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
    return { dpad, face, system };
  }

  // lib/touch-gamepad/utils.ts
  var PERSIST_KEY = "gv:touch-layouts-v2";
  var TOGGLE_KEY = "gv:touch-visible";
  function loadLayouts() {
    try {
      return JSON.parse(localStorage.getItem(PERSIST_KEY) || "{}");
    } catch {
      return {};
    }
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
    this._ctx = null;
    this._visible = false;
    this._animId = null;
    this._dragTarget = null;
    this._dragStart = null;
    this._editMode = false;
    this._showHandles = false;
    this._lockBtn = { x: 0.91, y: 0.01, w: 0.07, h: 0.07 };
    this._closeBtn = { x: 0.82, y: 0.01, w: 0.07, h: 0.07 };
    this._swapBtn = { x: 0.73, y: 0.01, w: 0.07, h: 0.07 };
    this.onInput = null;
    this._castMode = false;
    this._layouts = loadLayouts();
    this._loadLayout();
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);
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
    const src = stored || computeDefaults(this._preset, orientation);
    this._dpad = { x: src.dpad.x, y: src.dpad.y, w: src.dpad.w, h: src.dpad.h };
    this._face = (src.face || []).map((b) => ({
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      label: b.label || ""
    }));
    this._system = (src.system || []).map((b) => ({
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      label: b.label || ""
    }));
    this._faceStates = new Array(this._face.length).fill(false);
    this._systemStates = new Array(this._system.length).fill(false);
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
    if (this._visible) {
      this._resizeCanvas();
      this._scheduleRender();
    }
  };
  TouchGamepad.prototype.setLayout = function(layout) {
    this._layoutName = layout;
    this._loadLayout();
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
      const tmpL = f[i].label;
      f[i].label = f[j].label;
      f[j].label = tmpL;
    };
    swap(this._face, 0, 1);
    if (this._face.length >= 4) swap(this._face, 2, 3);
    this._saveLayout();
    if (this._visible) this._scheduleRender();
  };
  TouchGamepad.prototype.show = function() {
    if (this._visible) return;
    this._visible = true;
    this._ensureCanvas();
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
    if (this._animId) {
      cancelAnimationFrame(this._animId);
      this._animId = null;
    }
    this._video.style.maxHeight = "";
    this._video.style.objectFit = "";
    this._clearInputs();
    this._emitState();
    if (this._layoutName === "auto") {
      window.removeEventListener("orientationchange", this._onOrientationChange);
    }
    saveToggleState(false);
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
    this._canvas = null;
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
    c.style.pointerEvents = "auto";
    c.style.zIndex = "10";
    c.style.outline = "2px solid rgba(0,255,100,0.8)";
    const self = this;
    setTimeout(() => {
      if (c) c.style.outline = "none";
    }, 5e3);
    const parent = this._video.parentNode;
    if (parent && getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent.appendChild(c);
    this._canvas = c;
    this._ctx = c.getContext("2d");
    c.addEventListener("touchstart", this._onTouchStart, { passive: false });
    c.addEventListener("touchmove", this._onTouchMove, { passive: false });
    c.addEventListener("touchend", this._onTouchEnd);
    c.addEventListener("touchcancel", this._onTouchEnd);
    c.addEventListener("pointerdown", this._onPointerDown, { passive: false });
    c.addEventListener("pointermove", this._onPointerMove, { passive: false });
    c.addEventListener("pointerup", this._onPointerUp);
    c.addEventListener("pointercancel", this._onPointerUp);
  };
  TouchGamepad.prototype._resizeCanvas = function() {
    if (!this._canvas) return;
    const orientation = resolveOrientation(this._layoutName);
    let w, h;
    if (this._castMode) {
      this._canvas.style.position = "fixed";
      this._canvas.style.inset = "0";
      this._canvas.style.width = "100vw";
      this._canvas.style.height = "100vh";
      this._canvas.style.zIndex = "20";
      w = Math.round(window.innerWidth);
      h = Math.round(window.innerHeight);
    } else if (orientation === "vertical") {
      this._canvas.style.position = "fixed";
      this._canvas.style.bottom = "0";
      this._canvas.style.left = "0";
      this._canvas.style.top = "auto";
      this._canvas.style.width = "100vw";
      this._canvas.style.height = "50vh";
      this._canvas.style.zIndex = "10";
      this._video.style.maxHeight = "50vh";
      this._video.style.objectFit = "contain";
      w = Math.round(window.innerWidth);
      h = Math.round(window.innerHeight * 0.5);
    } else {
      this._canvas.style.position = "absolute";
      this._canvas.style.bottom = "auto";
      this._canvas.style.zIndex = "10";
      this._video.style.maxHeight = "";
      this._video.style.objectFit = "";
      const vr = this._video.getBoundingClientRect();
      const pr = this._canvas.parentNode.getBoundingClientRect();
      this._canvas.style.left = vr.left - pr.left + "px";
      this._canvas.style.top = vr.top - pr.top + "px";
      w = Math.round(vr.width);
      h = Math.round(vr.height);
      this._canvas.style.width = w + "px";
      this._canvas.style.height = h + "px";
    }
    if (w !== this._canvas.width || h !== this._canvas.height) {
      this._canvas.width = w;
      this._canvas.height = h;
    }
  };
  TouchGamepad.prototype._scheduleRender = function() {
    if (!this._animId) {
      this._animId = requestAnimationFrame(this._render);
    }
  };
  TouchGamepad.prototype._onOrientationChange = function() {
    if (!this._visible) return;
    const self = this;
    setTimeout(() => {
      self._loadLayout();
      self._resizeCanvas();
    }, 200);
  };
  TouchGamepad.prototype._findTouchZone = function(n) {
    const nx = n.x, ny = n.y;
    const RESIZE_R = 16 / (this._canvas?.width || 1);
    if (this._showHandles) {
      const d = this._dpad;
      const corners = [
        { x: d.x, y: d.y, tag: "resize:dpad:nw" },
        { x: d.x + d.w, y: d.y, tag: "resize:dpad:ne" },
        { x: d.x, y: d.y + d.h, tag: "resize:dpad:sw" },
        { x: d.x + d.w, y: d.y + d.h, tag: "resize:dpad:se" }
      ];
      for (const c of corners) {
        if (Math.abs(nx - c.x) < RESIZE_R * 1.5 && Math.abs(ny - c.y) < RESIZE_R * 1.5) {
          return { kind: "resize", zone: "dpad", tag: c.tag };
        }
      }
      for (let i = 0; i < this._face.length; i++) {
        const f = this._face[i];
        if (Math.abs(nx - (f.x + f.w)) < RESIZE_R * 1.5 && Math.abs(ny - (f.y + f.h)) < RESIZE_R * 1.5) {
          return { kind: "resize", zone: "face", tag: `resize:face:${i}` };
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
  TouchGamepad.prototype._hitLockBtn = function(nx, ny) {
    const lb = this._lockBtn;
    return nx >= lb.x && nx <= lb.x + lb.w && ny >= lb.y && ny <= lb.y + lb.h;
  };
  TouchGamepad.prototype._hitCloseBtn = function(nx, ny) {
    const cb = this._closeBtn;
    return nx >= cb.x && nx <= cb.x + cb.w && ny >= cb.y && ny <= cb.y + cb.h;
  };
  TouchGamepad.prototype._hitSwapBtn = function(nx, ny) {
    if (this._face.length < 4) return false;
    const sb = this._swapBtn;
    return nx >= sb.x && nx <= sb.x + sb.w && ny >= sb.y && ny <= sb.y + sb.h;
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
      drawResizeHandles(ctx, this._dpad, cw, ch);
      for (let i = 0; i < this._face.length; i++) {
        drawCornerHandle(ctx, this._face[i], cw, ch);
      }
    }
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
      ctx.fillText(isEdit ? "\u{1F513}" : "\u{1F512}", lbcx, lbcy);
    }
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
      ctx.font = Math.floor(cbr * 1) + "px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("\u2715", cbcx, cbcy);
    }
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
      ctx.fillText("\u2194", sbcx, sbcy);
    }
    if (this._showHandles) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, cw, 24);
      ctx.fillStyle = "rgba(0,200,255,0.9)";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("Unlocked \u2014 drag zones, corner handles to resize. Tap \u{1F513} to lock.", 8, 12);
    }
    this._animId = requestAnimationFrame(this._render);
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
    ctx.roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = pressed ? "rgba(56,189,248,0.5)" : "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1.5;
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
  function drawResizeHandles(ctx, d, cw, ch) {
    const corners = [
      { x: d.x * cw, y: d.y * ch },
      { x: (d.x + d.w) * cw, y: d.y * ch },
      { x: d.x * cw, y: (d.y + d.h) * ch },
      { x: (d.x + d.w) * cw, y: (d.y + d.h) * ch }
    ];
    ctx.fillStyle = "rgba(255,200,50,0.7)";
    for (const c of corners) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function drawCornerHandle(ctx, zone, cw, ch) {
    ctx.fillStyle = "rgba(255,200,50,0.7)";
    ctx.beginPath();
    ctx.arc((zone.x + zone.w) * cw, (zone.y + zone.h) * ch, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  function handleStart(gp, t, cw, self) {
    const rect = gp._canvas.getBoundingClientRect();
    const n = {
      x: (t.clientX - rect.left) / (rect.width || 1),
      y: (t.clientY - rect.top) / (rect.height || 1)
    };
    if (gp._hitLockBtn(n.x, n.y)) {
      if (gp._editMode) gp.exitEditMode();
      else gp.enterEditMode();
      return false;
    }
    if (gp._hitCloseBtn(n.x, n.y)) {
      gp.hide();
      return false;
    }
    if (gp._hitSwapBtn(n.x, n.y)) {
      gp.swapAB();
      return false;
    }
    const RESIZE_R = 16 / (cw || 1);
    const zone = gp._findTouchZone(n);
    if (gp._showHandles && zone && zone.kind === "resize") {
      gp._dragTarget = { kind: "resize", zone: zone.zone, tag: zone.tag };
      let tgt = null;
      if (zone.zone === "dpad") tgt = gp._dpad;
      else if (zone.zone === "face") {
        const idx = parseInt(String(zone.tag).split(":")[2] || "", 10);
        tgt = gp._face[idx] || null;
      }
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
      const dragZone = zone.kind === "dpad" ? { kind: "move", zone: "dpad" } : zone.kind === "face" ? { kind: "move", zone: zone.zone } : { kind: "move", zone: zone.zone || "system" };
      gp._dragTarget = dragZone;
      let tgt2 = null;
      if (dragZone.zone === "dpad") tgt2 = gp._dpad;
      else if (dragZone.zone && !isNaN(parseInt(dragZone.zone))) {
        const idx = parseInt(dragZone.zone, 10);
        tgt2 = gp._face[idx] || gp._system[idx] || null;
      }
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
        else if (gp._dragTarget.zone === "face") {
          tgt = gp._face[parseInt(gp._dragTarget.zone, 10)] || null;
        } else if (gp._dragTarget.zone === "system") {
          tgt = gp._system[parseInt(gp._dragTarget.zone, 10)] || null;
        }
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
        if (gp._hitLockBtn(n2.x, n2.y)) continue;
        if (gp._hitCloseBtn(n2.x, n2.y)) continue;
        if (gp._hitSwapBtn(n2.x, n2.y)) continue;
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
          gp._scheduleRender();
          break;
        }
      }
    }
    if (gp._editMode && !gp._dragTarget) {
      for (let j = 0; j < changedTouches.length; j++) {
        const nn = {
          x: (changedTouches[j].clientX - rect.left) / (cw || 1),
          y: (changedTouches[j].clientY - rect.top) / (ch || 1)
        };
        if (gp._hitLockBtn(nn.x, nn.y)) continue;
        if (gp._hitCloseBtn(nn.x, nn.y)) continue;
        if (gp._hitSwapBtn(nn.x, nn.y)) continue;
        const zz = gp._findTouchZone(nn);
        if (!zz || zz.kind === "resize") {
          gp.exitEditMode();
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
        if (gp._hitLockBtn(nm.x, nm.y)) continue;
        if (gp._hitCloseBtn(nm.x, nm.y)) continue;
        if (gp._hitSwapBtn(nm.x, nm.y)) continue;
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
  TouchGamepad.prototype._onTouchStart = function(e) {
    e.preventDefault();
    if (this._canvas && !this._canvas.width) {
      this._resizeCanvas();
    }
    const touches = e.changedTouches;
    const canvas = this._canvas;
    if (!canvas) return;
    const cw = canvas.width;
    for (let i = 0; i < touches.length; i++) {
      handleStart(this, touches[i], cw, this);
    }
    this._emitState();
  };
  TouchGamepad.prototype._onTouchMove = function(e) {
    e.preventDefault();
    handleMove(this, e.touches);
  };
  TouchGamepad.prototype._onTouchEnd = function(e) {
    handleEnd(this, e.changedTouches, e.touches);
  };
  TouchGamepad.prototype._onPointerDown = function(e) {
  };
  TouchGamepad.prototype._onPointerMove = function(e) {
  };
  TouchGamepad.prototype._onPointerUp = function(e) {
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
