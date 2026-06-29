// ── touch-gamepad.js v2 — repositionable / resizable virtual gamepad ────────
//
// Overlays D-pad + face buttons + system buttons (Start/Select/Coin) on a
// <video> element.  Emits standard Gamepad API-shaped state objects consumed
// by the existing GvPlayer._sendInput() pipeline.
//
// CONSOLE PRESETS
//   nes      — dpad + A,B (face) + Select,Start (system)
//   gamegear — dpad + 1,2 (face) + Start (system)
//   genesis  — dpad + A,B,C (face) + Start (system)
//   arcade   — dpad + 1,2,3,4 (face) + Coin,Start (system)
//
// LAYOUTS
//   horizontal — dpad left, face right, system center-bottom (landscape)
//   vertical   — controls below video (portrait)
//   auto       — picks based on screen dimensions
//
// Layout is persisted to localStorage per preset + orientation (v2 key).
// Long-press any zone to enter edit mode: drag to reposition, corner handle
// to resize.  Tap empty area to exit.  System buttons emit to gamepad
// indices 8 (Select/Coin) and 9 (Start).

(function (global) {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────

  var LONG_PRESS_MS = 400;
  var DPAD_DEAD_ZONE = 0.3;
  var RESIZE_HANDLE_RADIUS = 16;
  var PERSIST_KEY = 'gv:touch-layouts-v2';
  var TOGGLE_KEY = 'gv:touch-visible';

  // ── Console presets ────────────────────────────────────────────────────

  var PRESETS = {
    nes: {
      face:   [{ label: 'B' }, { label: 'A' }],
      system: [{ label: 'SELECT' }, { label: 'START' }],
    },
    gamegear: {
      face:   [{ label: '1' }, { label: '2' }],
      system: [{ label: 'START' }],
    },
    genesis: {
      face:   [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      system: [{ label: 'START' }],
    },
    arcade: {
      face:   [{ label: '1' }, { label: '2' }, { label: '3' }, { label: '4' }],
      system: [{ label: 'COIN' }, { label: 'START' }],
    },
  };

  // ── Default layout calculator ──────────────────────────────────────────

  /** Compute default zone positions for a preset + orientation.
   *  All coords are normalised 0..1 of the container. */
  function computeDefaults(preset, orientation) {
    var cfg = PRESETS[preset] || PRESETS.nes;
    var nFace = cfg.face.length;
    var nSys = cfg.system.length;
    var isHoriz = orientation === 'horizontal' || orientation === 'landscape';

    var dpad = { x: 0, y: 0, w: 0, h: 0 };
    var face = [];
    var system = [];

    if (isHoriz) {
      // ── Horizontal: dpad left, face right, system bottom-center ──

      dpad = { x: 0.03, y: 0.48, w: 0.22, h: 0.46 };

      // Face buttons: 2-column grid anchored bottom-right
      var cols = nFace <= 2 ? 2 : Math.min(nFace, 3);
      var rows = Math.ceil(nFace / cols);
      var bw = 0.10, bh = 0.12;
      var gap = 0.015;
      var gridW = cols * bw + (cols - 1) * gap;
      var gridH = rows * bh + (rows - 1) * gap;
      var startX = 0.97 - gridW;
      var startY = 0.94 - gridH;

      for (var fi = 0; fi < nFace; fi++) {
        var col = fi % cols;
        var row = Math.floor(fi / cols);
        face.push({
          x: startX + col * (bw + gap),
          y: startY + row * (bh + gap),
          w: bw, h: bh,
          label: cfg.face[fi].label,
        });
      }

      // System buttons: horizontal row centered below dpad
      var sw = 0.09, sh = 0.05;
      var sGap = 0.02;
      var sysW = nSys * sw + (nSys - 1) * sGap;
      var sysX = 0.50 - sysW / 2;
      var sysY = 0.92;
      for (var si = 0; si < nSys; si++) {
        system.push({
          x: sysX + si * (sw + sGap),
          y: sysY, w: sw, h: sh,
          label: cfg.system[si].label,
        });
      }
    } else {
      // ── Vertical: controls below video ──
      // Control bar occupies bottom 28% of container
      var barTop = 0.72;
      var barH = 0.28;

      dpad = { x: 0.03, y: barTop + 0.02, w: 0.24, h: barH - 0.04 };

      // Face buttons: horizontal row in center of control bar
      var vbw = 0.12, vbh = 0.16;
      var vgap = 0.03;
      var faceW = nFace * vbw + (nFace - 1) * vgap;
      var faceX = 0.50 - faceW / 2;
      var faceY = barTop + (barH - vbh) / 2;

      for (var vfi = 0; vfi < nFace; vfi++) {
        face.push({
          x: faceX + vfi * (vbw + vgap),
          y: faceY, w: vbw, h: vbh,
          label: cfg.face[vfi].label,
        });
      }

      // System buttons: right side of control bar, stacked or row
      var vsw = 0.09, vsh = 0.05;
      var vsGap = 0.015;
      var sysW2 = nSys * vsw + (nSys - 1) * vsGap;
      var sysX2 = 0.97 - sysW2;
      var sysY2 = barTop + (barH - vsh) / 2;
      for (var vsi = 0; vsi < nSys; vsi++) {
        system.push({
          x: sysX2 + vsi * (vsw + vsGap),
          y: sysY2, w: vsw, h: vsh,
          label: cfg.system[vsi].label,
        });
      }
    }

    return { dpad: dpad, face: face, system: system };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }

  function pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  function loadLayouts() {
    try { return JSON.parse(localStorage.getItem(PERSIST_KEY)) || {}; }
    catch (_) { return {}; }
  }

  function saveLayouts(data) {
    try { localStorage.setItem(PERSIST_KEY, JSON.stringify(data)); }
    catch (_) { /* quota exceeded */ }
  }

  function loadToggleState() {
    try { return localStorage.getItem(TOGGLE_KEY) !== '0'; }
    catch (_) { return true; }
  }

  function saveToggleState(visible) {
    try { localStorage.setItem(TOGGLE_KEY, visible ? '1' : '0'); }
    catch (_) {}
  }

  // ── Constructor ───────────────────────────────────────────────────────

  function TouchGamepad(video, opts) {
    opts = opts || {};
    this._video = video;
    this._preset = opts.preset || 'nes';
    this._layoutName = opts.layout || 'auto'; // 'horizontal'|'vertical'|'auto'

    // Zones (normalised coords 0..1)
    this._dpad = null;
    this._face = [];
    this._system = [];

    // Active input state
    this._dpadActive = [false, false, false, false]; // up down left right
    this._faceStates = [];
    this._systemStates = [];

    // Canvas
    this._canvas = null;
    this._ctx = null;
    this._visible = false;
    this._animId = null;

    // Drag state
    this._dragTarget = null;
    this._dragStart = null;
    this._longPressTimer = null;
    this._fingerStart = null;
    this._editMode = false;
    this._showHandles = false;

    this.onInput = null;

    // Persisted layouts
    this._layouts = loadLayouts();
    this._loadLayout();

    // Bind
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);
    this._onOrientationChange = this._onOrientationChange.bind(this);
    this._render = this._render.bind(this);
  }

  // ── Orientation ─────────────────────────────────────────────────────

  TouchGamepad.prototype._resolveOrientation = function () {
    if (this._layoutName === 'horizontal') return 'horizontal';
    if (this._layoutName === 'vertical') return 'vertical';
    if (!global.screen) return 'vertical';
    return global.screen.availWidth > global.screen.availHeight
      ? 'horizontal' : 'vertical';
  };

  // ── Layout load/save ────────────────────────────────────────────────

  TouchGamepad.prototype._layoutKey = function () {
    return this._preset + ':' + this._resolveOrientation();
  };

  TouchGamepad.prototype._loadLayout = function () {
    var key = this._layoutKey();
    var stored = (this._layouts[key]) ? this._layouts[key] : null;
    var src = stored || computeDefaults(this._preset, this._resolveOrientation());

    this._dpad = { x: src.dpad.x, y: src.dpad.y, w: src.dpad.w, h: src.dpad.h };
    this._face = (src.face || []).map(function (b) {
      return { x: b.x, y: b.y, w: b.w, h: b.h, label: b.label || '' };
    });
    this._system = (src.system || []).map(function (b) {
      return { x: b.x, y: b.y, w: b.w, h: b.h, label: b.label || '' };
    });
    this._faceStates = new Array(this._face.length).fill(false);
    this._systemStates = new Array(this._system.length).fill(false);
  };

  TouchGamepad.prototype._saveLayout = function () {
    var key = this._layoutKey();
    this._layouts[key] = {
      dpad: { x: this._dpad.x, y: this._dpad.y, w: this._dpad.w, h: this._dpad.h },
      face: this._face.map(function (b) {
        return { x: b.x, y: b.y, w: b.w, h: b.h, label: b.label };
      }),
      system: this._system.map(function (b) {
        return { x: b.x, y: b.y, w: b.w, h: b.h, label: b.label };
      }),
    };
    saveLayouts(this._layouts);
  };

  // ── Preset switching ────────────────────────────────────────────────

  TouchGamepad.prototype.setPreset = function (preset) {
    if (!PRESETS[preset]) return;
    this._preset = preset;
    this._loadLayout();
    if (this._visible) { this._resizeCanvas(); this._scheduleRender(); }
  };

  TouchGamepad.prototype.setLayout = function (layout) {
    this._layoutName = layout;
    this._loadLayout();
    if (this._visible) { this._resizeCanvas(); this._scheduleRender(); }
  };

  // ── Edit mode ───────────────────────────────────────────────────────

  TouchGamepad.prototype.enterEditMode = function () {
    this._editMode = true;
    this._showHandles = true;
    if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
    this._scheduleRender();
  };

  TouchGamepad.prototype.exitEditMode = function () {
    this._editMode = false;
    this._showHandles = false;
    this._saveLayout();
    this._scheduleRender();
  };

  // ── Show / hide / toggle ────────────────────────────────────────────

  TouchGamepad.prototype.show = function () {
    if (this._visible) return;
    this._visible = true;
    this._ensureCanvas();
    if (this._layoutName === 'auto') {
      global.addEventListener('orientationchange', this._onOrientationChange);
    }
    this._resizeCanvas();
    this._scheduleRender();
    saveToggleState(true);
  };

  TouchGamepad.prototype.hide = function () {
    this._visible = false;
    if (this._canvas) this._canvas.style.display = 'none';
    if (this._animId) { cancelAnimationFrame(this._animId); this._animId = null; }
    this._clearInputs();
    this._emitState();
    if (this._layoutName === 'auto') {
      global.removeEventListener('orientationchange', this._onOrientationChange);
    }
    saveToggleState(false);
  };

  TouchGamepad.prototype.toggle = function () {
    if (this._visible) this.hide();
    else this.show();
  };

  TouchGamepad.prototype.isVisible = function () {
    return this._visible;
  };

  TouchGamepad.prototype.destroy = function () {
    this.hide();
    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    this._canvas = null;
    this._ctx = null;
    if (this._longPressTimer) clearTimeout(this._longPressTimer);
  };

  // ── Canvas setup ────────────────────────────────────────────────────

  TouchGamepad.prototype._ensureCanvas = function () {
    if (this._canvas) {
      this._canvas.style.display = 'block';
      return;
    }
    this._canvas = document.createElement('canvas');
    this._canvas.style.position = 'absolute';
    this._canvas.style.top = '0';
    this._canvas.style.left = '0';
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    this._canvas.style.touchAction = 'none';
    this._canvas.style.pointerEvents = 'auto';
    this._canvas.style.zIndex = '10';

    var parent = this._video.parentNode;
    if (parent && getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    parent.appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');

    this._canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
    this._canvas.addEventListener('touchmove',  this._onTouchMove,  { passive: false });
    this._canvas.addEventListener('touchend',   this._onTouchEnd);
    this._canvas.addEventListener('touchcancel',this._onTouchEnd);
  };

  TouchGamepad.prototype._resizeCanvas = function () {
    if (!this._canvas) return;
    var parent = this._canvas.parentNode;
    var w = parent.clientWidth;
    var h = parent.clientHeight;
    if (w !== this._canvas.width || h !== this._canvas.height) {
      this._canvas.width = w;
      this._canvas.height = h;
    }
  };

  TouchGamepad.prototype._scheduleRender = function () {
    if (!this._animId) {
      this._animId = requestAnimationFrame(this._render);
    }
  };

  // ── Orientation change ─────────────────────────────────────────────

  TouchGamepad.prototype._onOrientationChange = function () {
    if (!this._visible) return;
    var self = this;
    setTimeout(function () {
      self._loadLayout();
      self._resizeCanvas();
    }, 200);
  };

  // ── Touch helpers ───────────────────────────────────────────────────

  TouchGamepad.prototype._touchToNorm = function (touch) {
    var rect = this._canvas.getBoundingClientRect();
    return {
      x: (touch.clientX - rect.left) / rect.width,
      y: (touch.clientY - rect.top) / rect.height,
    };
  };

  TouchGamepad.prototype._findTouchZone = function (nx, ny) {
    // Resize handles (edit mode)
    if (this._showHandles) {
      var hr = RESIZE_HANDLE_RADIUS / this._canvas.width;
      // Dpad: 4 corners
      var d = this._dpad;
      var corners = [
        { x: d.x, y: d.y, tag: 'resize:dpad:nw' },
        { x: d.x + d.w, y: d.y, tag: 'resize:dpad:ne' },
        { x: d.x, y: d.y + d.h, tag: 'resize:dpad:sw' },
        { x: d.x + d.w, y: d.y + d.h, tag: 'resize:dpad:se' },
      ];
      for (var ci = 0; ci < corners.length; ci++) {
        var c = corners[ci];
        if (Math.abs(nx - c.x) < hr * 1.5 && Math.abs(ny - c.y) < hr * 1.5) {
          return { kind: 'resize', zone: 'dpad', tag: c.tag };
        }
      }
      // Face button: bottom-right handle
      for (var fhi = 0; fhi < this._face.length; fhi++) {
        var fb = this._face[fhi];
        if (Math.abs(nx - (fb.x + fb.w)) < hr && Math.abs(ny - (fb.y + fb.h)) < hr) {
          return { kind: 'resize', zone: 'face', index: fhi };
        }
      }
      // System button: bottom-right handle
      for (var shi = 0; shi < this._system.length; shi++) {
        var sb = this._system[shi];
        if (Math.abs(nx - (sb.x + sb.w)) < hr && Math.abs(ny - (sb.y + sb.h)) < hr) {
          return { kind: 'resize', zone: 'system', index: shi };
        }
      }
    }

    // Hit test: dpad
    if (pointInRect(nx, ny, this._dpad)) return { kind: 'dpad' };

    // Hit test: face buttons
    for (var fi = 0; fi < this._face.length; fi++) {
      if (pointInRect(nx, ny, this._face[fi])) {
        return { kind: 'face', index: fi };
      }
    }

    // Hit test: system buttons
    for (var si = 0; si < this._system.length; si++) {
      if (pointInRect(nx, ny, this._system[si])) {
        return { kind: 'system', index: si };
      }
    }

    return null;
  };

  // ── Touch handlers ──────────────────────────────────────────────────

  TouchGamepad.prototype._onTouchStart = function (e) {
    e.preventDefault();
    var self = this;

    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var n = this._touchToNorm(t);

      // Edit mode: resize handle hit
      if (this._showHandles) {
        var rz = this._findTouchZone(n);
        if (rz && rz.kind === 'resize') {
          this._dragTarget = rz;
          var tgt = this._getZoneForDrag(rz);
          if (tgt) {
            this._dragStart = {
              fingerId: t.identifier,
              nx: n.x, ny: n.y,
              tx: tgt.x, ty: tgt.y, tw: tgt.w, th: tgt.h,
              mode: 'resize',
            };
          }
          this._scheduleRender();
          continue;
        }
      }

      var zone = this._findTouchZone(n);
      if (!zone) {
        if (this._editMode && !this._showHandles) {
          this._fingerStart = {
            fingerId: t.identifier, nx: n.x, ny: n.y, time: Date.now(),
          };
        }
        continue;
      }

      // Record for long-press
      this._fingerStart = {
        fingerId: t.identifier, nx: n.x, ny: n.y,
        time: Date.now(), zone: zone,
      };

      // Long-press timer → edit mode
      if (this._longPressTimer) clearTimeout(this._longPressTimer);
      this._longPressTimer = setTimeout(function () {
        self._editMode = true;
        self._showHandles = true;
        self._longPressTimer = null;
        if (self._fingerStart && self._fingerStart.zone) {
          var z = self._fingerStart.zone;
          var tg2 = self._getZoneForDrag(z);
          if (tg2) {
            self._dragTarget = z;
            self._dragStart = {
              fingerId: self._fingerStart.fingerId,
              nx: self._fingerStart.nx, ny: self._fingerStart.ny,
              tx: tg2.x, ty: tg2.y, tw: tg2.w, th: tg2.h,
              mode: 'move',
            };
          }
        }
        self._scheduleRender();
      }, LONG_PRESS_MS);

      // Apply input immediately (not in edit mode)
      if (!this._editMode) {
        this._applyZoneInput(zone, n);
        this._emitState();
      }
    }
  };

  TouchGamepad.prototype._onTouchMove = function (e) {
    e.preventDefault();

    // Dragging a zone
    if (this._dragTarget && this._dragStart) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier !== this._dragStart.fingerId) continue;
        var n = this._touchToNorm(t);
        var dx = n.x - this._dragStart.nx;
        var dy = n.y - this._dragStart.ny;

        var tgt = this._getZoneForDrag(this._dragTarget);
        if (!tgt) continue;

        if (this._dragStart.mode === 'move') {
          tgt.x = clamp(this._dragStart.tx + dx, 0, 1 - tgt.w);
          tgt.y = clamp(this._dragStart.ty + dy, 0, 1 - tgt.h);
        } else {
          tgt.w = clamp(this._dragStart.tw + dx, 0.04, 0.5);
          tgt.h = clamp(this._dragStart.th + dy, 0.03, 0.4);
        }
        this._scheduleRender();
        break;
      }
      return;
    }

    // Track active touches for input
    if (!this._editMode) {
      this._clearInputs();
      for (var j = 0; j < e.touches.length; j++) {
        var t2 = e.touches[j];
        var n2 = this._touchToNorm(t2);
        var zone2 = this._findTouchZone(n2);
        if (zone2) {
          this._applyZoneInput(zone2, n2);
        }
      }
      this._emitState();
    }

    // Cancel long-press if finger left zone
    if (this._fingerStart && this._longPressTimer) {
      for (var k = 0; k < e.changedTouches.length; k++) {
        if (e.changedTouches[k].identifier === this._fingerStart.fingerId) {
          var nn = this._touchToNorm(e.changedTouches[k]);
          var zz = this._findTouchZone(nn);
          if (!zz || zz.kind !== this._fingerStart.zone.kind ||
              (zz.index !== this._fingerStart.zone.index)) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
          }
          break;
        }
      }
    }
  };

  TouchGamepad.prototype._onTouchEnd = function (e) {
    // End drag
    if (this._dragTarget && this._dragStart) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === this._dragStart.fingerId) {
          this._dragTarget = null;
          this._dragStart = null;
          this._saveLayout();
          break;
        }
      }
    }

    // Tap on empty space → exit edit mode
    if (this._editMode && !this._dragTarget && this._fingerStart) {
      for (var j = 0; j < e.changedTouches.length; j++) {
        if (e.changedTouches[j].identifier === this._fingerStart.fingerId) {
          var elapsed = Date.now() - this._fingerStart.time;
          var n = this._touchToNorm(e.changedTouches[j]);
          var dx2 = n.x - this._fingerStart.nx;
          var dy2 = n.y - this._fingerStart.ny;
          var dist = Math.sqrt(dx2 * dx2 + dy2 * dy2);
          if (elapsed < LONG_PRESS_MS && dist < 0.03 && !this._findTouchZone(n)) {
            this.exitEditMode();
          }
          break;
        }
      }
    }

    // Cancel long-press
    if (this._fingerStart) {
      for (var k = 0; k < e.changedTouches.length; k++) {
        if (e.changedTouches[k].identifier === this._fingerStart.fingerId) {
          if (this._longPressTimer) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
          }
          this._fingerStart = null;
          break;
        }
      }
    }

    // Recalculate inputs from remaining touches
    this._clearInputs();
    for (var m = 0; m < e.touches.length; m++) {
      var tm = e.touches[m];
      var nm = this._touchToNorm(tm);
      var zm = this._findTouchZone(nm);
      if (zm && !this._editMode) {
        this._applyZoneInput(zm, nm);
      }
    }
    this._emitState();
    this._scheduleRender();
  };

  // ── Zone accessor for drag ─────────────────────────────────────────

  TouchGamepad.prototype._getZoneForDrag = function (zone) {
    if (!zone) return null;
    if (zone.kind === 'dpad' || zone.zone === 'dpad') return this._dpad;
    if (zone.kind === 'face') return this._face[zone.index];
    if (zone.kind === 'system') return this._system[zone.index];
    if (zone.zone === 'face') return this._face[zone.index];
    if (zone.zone === 'system') return this._system[zone.index];
    return null;
  };

  // ── Input mapping ───────────────────────────────────────────────────

  TouchGamepad.prototype._applyZoneInput = function (zone, n) {
    if (zone.kind === 'dpad') {
      var dx = (n.x - this._dpad.x) / this._dpad.w;
      var dy = (n.y - this._dpad.y) / this._dpad.h;
      var ax = (dx - 0.5) * 2;
      var ay = (dy - 0.5) * 2;
      var mag = Math.sqrt(ax * ax + ay * ay);
      if (mag < DPAD_DEAD_ZONE) {
        this._dpadActive = [false, false, false, false];
        return;
      }
      var absAx = Math.abs(ax), absAy = Math.abs(ay);
      this._dpadActive[0] = ay < -DPAD_DEAD_ZONE && absAy >= absAx;
      this._dpadActive[1] = ay >  DPAD_DEAD_ZONE && absAy >= absAx;
      this._dpadActive[2] = ax < -DPAD_DEAD_ZONE && absAx >  absAy;
      this._dpadActive[3] = ax >  DPAD_DEAD_ZONE && absAx >  absAy;
    } else if (zone.kind === 'face') {
      this._faceStates[zone.index] = true;
    } else if (zone.kind === 'system') {
      this._systemStates[zone.index] = true;
    }
  };

  TouchGamepad.prototype._clearInputs = function () {
    this._dpadActive = [false, false, false, false];
    for (var i = 0; i < this._faceStates.length; i++) this._faceStates[i] = false;
    for (var j = 0; j < this._systemStates.length; j++) this._systemStates[j] = false;
  };

  // ── Emit gamepad state ──────────────────────────────────────────────

  TouchGamepad.prototype._emitState = function () {
    if (!this.onInput) return;

    // Standard Gamepad mapping:
    //   buttons[0..3]   = face A,B,X,Y (we use 0=A, 1=B, 2=X, 3=Y)
    //   buttons[8]      = Select (or Coin for arcade)
    //   buttons[9]      = Start
    //   buttons[12..15] = dpad up,down,left,right
    var buttons = new Array(17).fill(false);

    // Face buttons → indices 0..3
    for (var fi = 0; fi < this._faceStates.length; fi++) {
      buttons[fi] = this._faceStates[fi];
    }

    // System buttons → indices 8 (Select/Coin), 9 (Start)
    for (var si = 0; si < this._systemStates.length; si++) {
      var label = (this._system[si].label || '').toUpperCase();
      if (label === 'START') {
        buttons[9] = this._systemStates[si];
      } else {
        // SELECT or COIN → button 8
        buttons[8] = this._systemStates[si];
      }
    }

    // Dpad
    buttons[12] = this._dpadActive[0]; // up
    buttons[13] = this._dpadActive[1]; // down
    buttons[14] = this._dpadActive[2]; // left
    buttons[15] = this._dpadActive[3]; // right

    // Axes: dpad as left stick
    var axes = [0, 0, 0, 0];
    if (this._dpadActive[2]) axes[0] = -1;
    else if (this._dpadActive[3]) axes[0] = 1;
    if (this._dpadActive[0]) axes[1] = -1;
    else if (this._dpadActive[1]) axes[1] = 1;

    this.onInput(buttons, axes);
  };

  // ── Render ──────────────────────────────────────────────────────────

  TouchGamepad.prototype._render = function () {
    this._animId = null;
    if (!this._visible || !this._canvas) return;

    this._resizeCanvas();
    var ctx = this._ctx;
    var cw = this._canvas.width;
    var ch = this._canvas.height;

    ctx.clearRect(0, 0, cw, ch);

    var baseAlpha = this._showHandles ? 0.45 : 0.22;

    // ── D-pad ───────────────────────────────────────────────────────
    var d = this._dpad;
    var dx = d.x * cw, dy = d.y * ch, dw = d.w * cw, dh = d.h * ch;
    var cx = dx + dw / 2, cy = dy + dh / 2;

    ctx.fillStyle = 'rgba(255,255,255,' + baseAlpha + ')';
    ctx.strokeStyle = 'rgba(255,255,255,' + (baseAlpha + 0.15) + ')';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, dw / 2, dh / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Cross hairs
    ctx.strokeStyle = 'rgba(255,255,255,' + (baseAlpha - 0.05) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, dy + 4); ctx.lineTo(cx, dy + dh - 4);
    ctx.moveTo(dx + 4, cy); ctx.lineTo(dx + dw - 4, cy);
    ctx.stroke();

    // Direction highlights
    var dirs = ['up', 'down', 'left', 'right'];
    for (var di = 0; di < 4; di++) {
      if (!this._dpadActive[di]) continue;
      ctx.fillStyle = 'rgba(100,180,255,0.5)';
      var halfW = dw / 2, halfH = dh / 2;
      var arcS, arcE;
      if (di === 0) { arcS = -Math.PI * 0.75; arcE = -Math.PI * 0.25; }
      else if (di === 1) { arcS = Math.PI * 0.25; arcE = Math.PI * 0.75; }
      else if (di === 2) { arcS = Math.PI * 0.75; arcE = Math.PI * 1.25; }
      else { arcS = -Math.PI * 0.25; arcE = Math.PI * 0.25; }
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, Math.min(halfW, halfH) * 0.65, arcS, arcE);
      ctx.closePath();
      ctx.fill();
    }

    // Arrow indicators
    ctx.fillStyle = 'rgba(255,255,255,' + (baseAlpha + 0.3) + ')';
    var arrowSize = Math.min(dw, dh) * 0.22;
    ctx.font = arrowSize + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var ayo = dh * 0.25, axo = dw * 0.25;
    ctx.fillText('\u25B2', cx, cy - ayo);
    ctx.fillText('\u25BC', cx, cy + ayo);
    ctx.fillText('\u25C0', cx - axo, cy);
    ctx.fillText('\u25B6', cx + axo, cy);

    // Dpad resize handles (edit mode)
    if (this._showHandles) {
      ctx.fillStyle = 'rgba(0,200,255,0.7)';
      var hSize = 8;
      var corners = [[dx, dy], [dx + dw, dy], [dx, dy + dh], [dx + dw, dy + dh]];
      for (var ci2 = 0; ci2 < 4; ci2++) {
        ctx.fillRect(corners[ci2][0] - hSize / 2, corners[ci2][1] - hSize / 2, hSize, hSize);
      }
    }

    // ── Face buttons ────────────────────────────────────────────────
    for (var fbi = 0; fbi < this._face.length; fbi++) {
      var b = this._face[fbi];
      var bx = b.x * cw, by = b.y * ch, bw = b.w * cw, bh = b.h * ch;
      var bcx = bx + bw / 2, bcy = by + bh / 2;
      var bRadius = Math.min(bw, bh) / 2;

      var btnAlpha = this._faceStates[fbi] ? 0.6 : baseAlpha;
      ctx.fillStyle = 'rgba(255,255,255,' + btnAlpha + ')';
      ctx.strokeStyle = 'rgba(255,255,255,' + (btnAlpha + 0.2) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(bcx, bcy, bRadius * 0.9, bRadius * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (this._faceStates[fbi]) {
        ctx.fillStyle = 'rgba(100,180,255,0.35)';
        ctx.beginPath();
        ctx.ellipse(bcx, bcy, bRadius * 0.85, bRadius * 0.85, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = (bRadius * 0.9) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label || String(fbi + 1), bcx, bcy);

      // Resize handle
      if (this._showHandles) {
        ctx.fillStyle = 'rgba(0,200,255,0.7)';
        ctx.fillRect(bx + bw - hSize / 2, by + bh - hSize / 2, hSize, hSize);
      }
    }

    // ── System buttons ──────────────────────────────────────────────
    for (var sbi = 0; sbi < this._system.length; sbi++) {
      var sb = this._system[sbi];
      var sbx = sb.x * cw, sby = sb.y * ch, sbw = sb.w * cw, sbh = sb.h * ch;
      var sbcx = sbx + sbw / 2, sbcy = sby + sbh / 2;
      var sbr = Math.min(sbw, sbh) / 2;

      var sysAlpha = this._systemStates[sbi] ? 0.55 : 0.18;
      ctx.fillStyle = 'rgba(220,180,80,' + sysAlpha + ')';
      ctx.strokeStyle = 'rgba(200,160,60,' + (sysAlpha + 0.15) + ')';
      ctx.lineWidth = 1.5;
      // Rounded rect (pill shape)
      var rr = sbr * 0.8;
      ctx.beginPath();
      ctx.moveTo(sbx + rr, sby);
      ctx.lineTo(sbx + sbw - rr, sby);
      ctx.arcTo(sbx + sbw, sby, sbx + sbw, sby + rr, rr);
      ctx.lineTo(sbx + sbw, sby + sbh - rr);
      ctx.arcTo(sbx + sbw, sby + sbh, sbx + sbw - rr, sby + sbh, rr);
      ctx.lineTo(sbx + rr, sby + sbh);
      ctx.arcTo(sbx, sby + sbh, sbx, sby + sbh - rr, rr);
      ctx.lineTo(sbx, sby + rr);
      ctx.arcTo(sbx, sby, sbx + rr, sby, rr);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Active glow
      if (this._systemStates[sbi]) {
        ctx.fillStyle = 'rgba(220,200,80,0.35)';
        ctx.beginPath();
        ctx.moveTo(sbx + rr, sby);
        ctx.lineTo(sbx + sbw - rr, sby);
        ctx.arcTo(sbx + sbw, sby, sbx + sbw, sby + rr, rr);
        ctx.lineTo(sbx + sbw, sby + sbh - rr);
        ctx.arcTo(sbx + sbw, sby + sbh, sbx + sbw - rr, sby + sbh, rr);
        ctx.lineTo(sbx + rr, sby + sbh);
        ctx.arcTo(sbx, sby + sbh, sbx, sby + sbh - rr, rr);
        ctx.lineTo(sbx, sby + rr);
        ctx.arcTo(sbx, sby, sbx + rr, sby, rr);
        ctx.closePath();
        ctx.fill();
      }

      ctx.fillStyle = 'rgba(220,180,80,0.9)';
      ctx.font = Math.max(10, sbr * 0.9) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(sb.label || '', sbcx, sbcy);

      // Resize handle
      if (this._showHandles) {
        ctx.fillStyle = 'rgba(0,200,255,0.7)';
        ctx.fillRect(sbx + sbw - hSize / 2, sby + sbh - hSize / 2, hSize, hSize);
      }
    }

    // ── Edit mode banner ────────────────────────────────────────────
    if (this._showHandles) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, cw, 24);
      ctx.fillStyle = 'rgba(0,200,255,0.9)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('Edit — drag to move, corner handles to resize. Tap outside to exit.', 8, 12);
    }

    this._animId = requestAnimationFrame(this._render);
  };

  // ── Export ──────────────────────────────────────────────────────────

  global.TouchGamepad = TouchGamepad;

})(typeof window !== 'undefined' ? window : this);
