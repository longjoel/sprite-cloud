// ── touch-gamepad.js — repositionable / resizable virtual gamepad ───────
//
// Overlays a D-pad + action buttons on a <video> element.
// Emits standard Gamepad API-shaped state objects consumed by
// the existing GvPlayer._sendInput() pipeline.
//
// Layout is persisted to localStorage per console + orientation.
// Touch zones are draggable (long-press) and resizable (pinch or edge drag).
//
// Usage:
//   const tg = new TouchGamepad(videoEl, { layout: 'portrait' });
//   tg.onInput = (buttons, axes) => player._sendInput({ index: 0, buttons, axes });
//   tg.show();
//   tg.setButtonLabels(['A','B']);   // after core detected

(function (global) {
  'use strict';

  // ── constants ──────────────────────────────────────────────────────────

  const LONG_PRESS_MS = 400;
  const DPAD_DEAD_ZONE = 0.3;       // fraction of dpad radius before axis fires
  const RESIZE_HANDLE_RADIUS = 20;  // px from edge for resize drag
  const PERSIST_KEY = 'gv:touch-layouts';

  // ── default layouts ───────────────────────────────────────────────────

  const DEFAULTS = {
    portrait: {
      dpad:  { x: 0.05, y: 0.60, w: 0.42, h: 0.35 },
      btns:  [
        { x: 0.60, y: 0.72, w: 0.14, h: 0.10, label: 'B' },
        { x: 0.78, y: 0.60, w: 0.14, h: 0.10, label: 'A' },
      ],
    },
    landscape: {
      dpad:  { x: 0.02, y: 0.55, w: 0.28, h: 0.40 },
      btns:  [
        { x: 0.72, y: 0.65, w: 0.10, h: 0.13, label: 'B' },
        { x: 0.86, y: 0.52, w: 0.10, h: 0.13, label: 'A' },
      ],
    },
  };

  // ── helper: load / save persisted layouts ─────────────────────────────

  function loadLayouts() {
    try { return JSON.parse(localStorage.getItem(PERSIST_KEY)) || {}; }
    catch (_) { return {}; }
  }

  function saveLayouts(layouts) {
    try { localStorage.setItem(PERSIST_KEY, JSON.stringify(layouts)); }
    catch (_) { /* quota exceeded — silently ignore */ }
  }

  // ── helper: point-in-rect ─────────────────────────────────────────────

  function pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  // ── constructor ───────────────────────────────────────────────────────

  function TouchGamepad(video, opts) {
    opts = opts || {};
    this._video = video;
    this._layoutName = opts.layout || 'portrait'; // 'portrait' | 'landscape' | 'auto'

    // Normalised coords (0..1) — converted to px on every frame
    this._dpad = null;
    this._buttons = [];

    this._dpadActive = [false, false, false, false]; // up down left right
    this._buttonStates = [];

    this._canvas = null;
    this._ctx = null;
    this._visible = false;
    this._animId = null;

    // Drag state
    this._dragTarget = null;    // 'dpad' | 'btn:0' | 'btn:resize:0'
    this._dragStart = null;     // { fingerId, px, py, targetX, targetY, targetW, targetH }
    this._longPressTimer = null;
    this._fingerStart = null;   // { fingerId, px, py, time }
    this._editMode = false;     // when true, zones are draggable (long-press or explicit)
    this._showHandles = false;  // triggered after long-press enters edit mode

    this.onInput = null;  // (buttons: bool[], axes: number[]) => void

    // Stored layouts per orientation
    this._layouts = loadLayouts();
    this._loadLayout();

    // Bind methods
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);
    this._onOrientationChange = this._onOrientationChange.bind(this);
    this._render = this._render.bind(this);
  }

  // ── layout loading ────────────────────────────────────────────────────

  TouchGamepad.prototype._resolveOrientation = function () {
    if (this._layoutName !== 'auto') return this._layoutName;
    if (!global.screen) return 'portrait';
    return global.screen.availWidth > global.screen.availHeight ? 'landscape' : 'portrait';
  };

  TouchGamepad.prototype._loadLayout = function () {
    var orientation = this._resolveOrientation();
    var stored = (this._layouts[orientation]) ? this._layouts[orientation] : null;
    var src = stored || DEFAULTS[orientation] || DEFAULTS.portrait;

    this._dpad = {
      x: src.dpad.x, y: src.dpad.y, w: src.dpad.w, h: src.dpad.h,
    };
    this._buttons = (src.btns || []).slice(0, 4).map(function (b, i) {
      return { x: b.x, y: b.y, w: b.w, h: b.h, label: b.label || '' };
    });
    this._buttonStates = new Array(this._buttons.length).fill(false);
  };

  TouchGamepad.prototype._saveLayout = function () {
    var orientation = this._resolveOrientation();
    this._layouts[orientation] = {
      dpad: { x: this._dpad.x, y: this._dpad.y, w: this._dpad.w, h: this._dpad.h },
      btns: this._buttons.map(function (b) {
        return { x: b.x, y: b.y, w: b.w, h: b.h, label: b.label };
      }),
    };
    saveLayouts(this._layouts);
  };

  // ── button labels ─────────────────────────────────────────────────────

  /** Call after core detection to label buttons (e.g. ['A','B','X','Y']) */
  TouchGamepad.prototype.setButtonLabels = function (labels) {
    for (var i = 0; i < this._buttons.length && i < labels.length; i++) {
      this._buttons[i].label = labels[i];
    }
  };

  /** Set explicit button count (1-4). Resets labels. */
  TouchGamepad.prototype.setButtonCount = function (n) {
    n = Math.max(1, Math.min(4, n));
    while (this._buttons.length < n) {
      this._buttons.push({
        x: 0.5 + this._buttons.length * 0.15,
        y: 0.5,
        w: 0.12,
        h: 0.15,
        label: '',
      });
    }
    this._buttons.length = n;
    this._buttonStates = new Array(n).fill(false);
  };

  // ── edit mode ─────────────────────────────────────────────────────────

  /** Enter explicit edit mode (no long-press needed). */
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

  // ── show / hide ───────────────────────────────────────────────────────

  TouchGamepad.prototype.show = function () {
    if (this._visible) return;
    this._visible = true;
    this._orientation = this._resolveOrientation();

    if (!this._canvas) {
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
      this._video.parentNode.appendChild(this._canvas);
      this._ctx = this._canvas.getContext('2d');

      this._canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
      this._canvas.addEventListener('touchmove',  this._onTouchMove,  { passive: false });
      this._canvas.addEventListener('touchend',   this._onTouchEnd);
      this._canvas.addEventListener('touchcancel',this._onTouchEnd);
    } else {
      this._canvas.style.display = 'block';
    }

    if (this._layoutName === 'auto') {
      global.addEventListener('orientationchange', this._onOrientationChange);
    }

    this._resizeCanvas();
    this._scheduleRender();
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

  // ── canvas sizing ─────────────────────────────────────────────────────

  TouchGamepad.prototype._resizeCanvas = function () {
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

  // ── orientation change ────────────────────────────────────────────────

  TouchGamepad.prototype._onOrientationChange = function () {
    if (!this._visible) return;
    var prev = this._resolveOrientation();
    // Re-resolve after a tick so screen dimensions update
    var self = this;
    setTimeout(function () {
      var now = self._resolveOrientation();
      if (now !== prev) {
        self._loadLayout();
        self._resizeCanvas();
      }
    }, 200);
  };

  // ── touch handlers ────────────────────────────────────────────────────

  TouchGamepad.prototype._touchToNorm = function (touch) {
    var rect = this._canvas.getBoundingClientRect();
    return {
      x: (touch.clientX - rect.left) / rect.width,
      y: (touch.clientY - rect.top) / rect.height,
    };
  };

  TouchGamepad.prototype._findTouchZone = function (nx, ny) {
    // Check resize handles first (when in edit mode)
    if (this._showHandles) {
      // Dpad resize handles (4 corners)
      var d = this._dpad;
      var corners = [
        { x: d.x, y: d.y, tag: 'dpad-resize:nw' },
        { x: d.x + d.w, y: d.y, tag: 'dpad-resize:ne' },
        { x: d.x, y: d.y + d.h, tag: 'dpad-resize:sw' },
        { x: d.x + d.w, y: d.y + d.h, tag: 'dpad-resize:se' },
      ];
      for (var ci = 0; ci < corners.length; ci++) {
        var c = corners[ci];
        var hr = RESIZE_HANDLE_RADIUS / this._canvas.width; // approx
        if (Math.abs(nx - c.x) < hr * 1.5 && Math.abs(ny - c.y) < hr * 1.5) {
          return { kind: 'resize', target: 'dpad', corner: c.tag };
        }
      }
      // Button resize handles
      for (var bi = 0; bi < this._buttons.length; bi++) {
        var b = this._buttons[bi];
        var bhr = RESIZE_HANDLE_RADIUS / this._canvas.width;
        if (Math.abs(nx - (b.x + b.w)) < bhr && Math.abs(ny - (b.y + b.h)) < bhr) {
          return { kind: 'resize', target: 'btn:' + bi };
        }
      }
    }

    // Check dpad
    if (pointInRect(nx, ny, this._dpad)) {
      return { kind: 'dpad' };
    }

    // Check buttons
    for (var i = 0; i < this._buttons.length; i++) {
      if (pointInRect(nx, ny, this._buttons[i])) {
        return { kind: 'btn', index: i };
      }
    }

    return null;
  };

  TouchGamepad.prototype._onTouchStart = function (e) {
    e.preventDefault();
    var self = this;

    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var n = this._touchToNorm(t);

      // If in edit mode with handles, first touch on a drag target enters drag
      if (this._showHandles) {
        var rz = this._findTouchZone(n);
        if (rz && rz.kind === 'resize') {
          this._dragTarget = rz.target;
          if (rz.target === 'dpad') {
            this._dragStart = {
              fingerId: t.identifier,
              nx: n.x, ny: n.y,
              tx: this._dpad.x, ty: this._dpad.y, tw: this._dpad.w, th: this._dpad.h,
              mode: 'resize',
            };
          } else {
            var bi = parseInt(rz.target.split(':')[1], 10);
            var b = this._buttons[bi];
            this._dragTarget = rz.target;
            this._dragStart = {
              fingerId: t.identifier,
              nx: n.x, ny: n.y,
              tx: b.x, ty: b.y, tw: b.w, th: b.h,
              mode: 'resize',
            };
          }
          this._scheduleRender();
          continue;
        }
      }

      var zone = this._findTouchZone(n);
      if (!zone) {
        // Touch outside all zones — nop unless in edit mode (dismisses edit)
        if (this._editMode && !this._showHandles) {
          // Long-press on empty space exits edit
          this._fingerStart = {
            fingerId: t.identifier,
            nx: n.x, ny: n.y,
            time: Date.now(),
          };
        }
        continue;
      }

      // Record finger for long-press detection
      this._fingerStart = {
        fingerId: t.identifier,
        nx: n.x, ny: n.y,
        time: Date.now(),
        zone: zone,
      };

      // Start long-press timer (enters edit mode)
      if (this._longPressTimer) clearTimeout(this._longPressTimer);
      this._longPressTimer = setTimeout(function () {
        self._editMode = true;
        self._showHandles = true;
        self._longPressTimer = null;

        // Start drag if finger is still down on a zone
        if (self._fingerStart && self._fingerStart.zone) {
          var z = self._fingerStart.zone;
          if (z.kind === 'dpad') {
            self._dragTarget = 'dpad';
            self._dragStart = {
              fingerId: self._fingerStart.fingerId,
              nx: self._fingerStart.nx, ny: self._fingerStart.ny,
              tx: self._dpad.x, ty: self._dpad.y, tw: self._dpad.w, th: self._dpad.h,
              mode: 'move',
            };
          } else if (z.kind === 'btn') {
            self._dragTarget = 'btn:' + z.index;
            var b = self._buttons[z.index];
            self._dragStart = {
              fingerId: self._fingerStart.fingerId,
              nx: self._fingerStart.nx, ny: self._fingerStart.ny,
              tx: b.x, ty: b.y, tw: b.w, th: b.h,
              mode: 'move',
            };
          }
        }
        self._scheduleRender();
      }, LONG_PRESS_MS);

      // Apply input immediately
      if (!this._editMode) {
        this._applyZoneInput(zone, n);
        this._emitState();
      }
    }
  };

  TouchGamepad.prototype._onTouchMove = function (e) {
    e.preventDefault();

    // If dragging a zone
    if (this._dragTarget && this._dragStart) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier !== this._dragStart.fingerId) continue;

        var n = this._touchToNorm(t);
        var dx = n.x - this._dragStart.nx;
        var dy = n.y - this._dragStart.ny;

        if (this._dragTarget === 'dpad') {
          if (this._dragStart.mode === 'move') {
            this._dpad.x = clamp(this._dragStart.tx + dx, 0, 1 - this._dpad.w);
            this._dpad.y = clamp(this._dragStart.ty + dy, 0, 1 - this._dpad.h);
          } else {
            // Resize from corner
            this._dpad.w = clamp(this._dragStart.tw + dx, 0.08, 0.6);
            this._dpad.h = clamp(this._dragStart.th + dy, 0.08, 0.5);
          }
        } else if (this._dragTarget.indexOf('btn:') === 0) {
          var bi = parseInt(this._dragTarget.split(':')[1], 10);
          var b = this._buttons[bi];
          if (this._dragStart.mode === 'move') {
            b.x = clamp(this._dragStart.tx + dx, 0, 1 - b.w);
            b.y = clamp(this._dragStart.ty + dy, 0, 1 - b.h);
          } else {
            b.w = clamp(this._dragStart.tw + dx, 0.04, 0.3);
            b.h = clamp(this._dragStart.th + dy, 0.04, 0.25);
          }
        }
        this._scheduleRender();
        break;
      }
      return;
    }

    // Track active touches for input
    if (!this._editMode) {
      this._clearInputs();
      var activeMap = {};
      for (var j = 0; j < e.touches.length; j++) {
        var t2 = e.touches[j];
        var n2 = this._touchToNorm(t2);
        var zone2 = this._findTouchZone(n2);
        if (zone2) {
          activeMap[t2.identifier] = zone2;
          this._applyZoneInput(zone2, n2);
        }
      }
      this._emitState();
    }

    // Check if finger left the zone → cancel long-press
    if (this._fingerStart && this._longPressTimer) {
      for (var k = 0; k < e.changedTouches.length; k++) {
        if (e.changedTouches[k].identifier === this._fingerStart.fingerId) {
          var nn = this._touchToNorm(e.changedTouches[k]);
          var zz = this._findTouchZone(nn);
          if (!zz || zz.kind !== this._fingerStart.zone.kind ||
            (zz.kind === 'btn' && zz.index !== this._fingerStart.zone.index)) {
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

    // Detect tap on empty space → exit edit mode
    if (this._editMode && !this._dragTarget && this._fingerStart) {
      for (var j = 0; j < e.changedTouches.length; j++) {
        if (e.changedTouches[j].identifier === this._fingerStart.fingerId) {
          var elapsed = Date.now() - this._fingerStart.time;
          var n = this._touchToNorm(e.changedTouches[j]);
          var dx = n.x - this._fingerStart.nx;
          var dy = n.y - this._fingerStart.ny;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (elapsed < LONG_PRESS_MS && dist < 0.03 && !this._findTouchZone(n)) {
            // Quick tap on empty space → exit edit
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

    // Clear inputs from released fingers
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

  // ── input mapping ─────────────────────────────────────────────────────

  TouchGamepad.prototype._applyZoneInput = function (zone, n) {
    if (zone.kind === 'dpad') {
      // Normalise position within dpad
      var dx = (n.x - this._dpad.x) / this._dpad.w;  // 0..1
      var dy = (n.y - this._dpad.y) / this._dpad.h;
      // Center is 0.5, 0.5 — compute axis values
      var ax = (dx - 0.5) * 2;  // -1..1
      var ay = (dy - 0.5) * 2;

      // Dead zone
      var mag = Math.sqrt(ax * ax + ay * ay);
      if (mag < DPAD_DEAD_ZONE) {
        this._dpadActive = [false, false, false, false];
        return;
      }

      // Cardinal direction
      var absAx = Math.abs(ax);
      var absAy = Math.abs(ay);
      this._dpadActive[0] = ay < -DPAD_DEAD_ZONE && absAy >= absAx;  // up
      this._dpadActive[1] = ay >  DPAD_DEAD_ZONE && absAy >= absAx;  // down
      this._dpadActive[2] = ax < -DPAD_DEAD_ZONE && absAx >  absAy;  // left
      this._dpadActive[3] = ax >  DPAD_DEAD_ZONE && absAx >  absAy;  // right
    } else if (zone.kind === 'btn') {
      this._buttonStates[zone.index] = true;
    }
  };

  TouchGamepad.prototype._clearInputs = function () {
    this._dpadActive = [false, false, false, false];
    for (var i = 0; i < this._buttonStates.length; i++) {
      this._buttonStates[i] = false;
    }
  };

  /** Build a gamepadState-like object matching what _sendInput expects. */
  TouchGamepad.prototype._emitState = function () {
    if (!this.onInput) return;
    // Standard Gamepad mapping:
    // buttons[0..3] = A, B, X, Y (or B, A, Y, X for Nintendo layout)
    // buttons[12] = D-pad up, 13 = down, 14 = left, 15 = right
    var buttons = new Array(17).fill(false);
    for (var i = 0; i < this._buttonStates.length; i++) {
      buttons[i] = this._buttonStates[i];
    }
    buttons[12] = this._dpadActive[0]; // up
    buttons[13] = this._dpadActive[1]; // down
    buttons[14] = this._dpadActive[2]; // left
    buttons[15] = this._dpadActive[3]; // right

    // Axes: dpad as left stick axes 0,1
    var axes = [0, 0, 0, 0];
    if (this._dpadActive[2]) axes[0] = -1;
    else if (this._dpadActive[3]) axes[0] = 1;
    if (this._dpadActive[0]) axes[1] = -1;
    else if (this._dpadActive[1]) axes[1] = 1;

    this.onInput(buttons, axes);
  };

  // ── render ────────────────────────────────────────────────────────────

  TouchGamepad.prototype._render = function () {
    this._animId = null;
    if (!this._visible || !this._canvas) return;

    this._resizeCanvas();
    var ctx = this._ctx;
    var cw = this._canvas.width;
    var ch = this._canvas.height;

    ctx.clearRect(0, 0, cw, ch);

    var alpha = this._showHandles ? 0.45 : 0.22;

    // ── D-pad ─────────────────────────────────────────────────────
    var d = this._dpad;
    var dx = d.x * cw, dy = d.y * ch, dw = d.w * cw, dh = d.h * ch;
    var cx = dx + dw / 2, cy = dy + dh / 2;

    // Base circle
    ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
    ctx.strokeStyle = 'rgba(255,255,255,' + (alpha + 0.15) + ')';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, dw / 2, dh / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Cross hairs
    ctx.strokeStyle = 'rgba(255,255,255,' + (alpha - 0.05) + ')';
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
      var arcStart, arcEnd;
      var halfW = dw / 2, halfH = dh / 2;
      if (di === 0)      { arcStart = -Math.PI * 0.75; arcEnd = -Math.PI * 0.25; } // up (top arc)
      else if (di === 1) { arcStart =  Math.PI * 0.25; arcEnd =  Math.PI * 0.75; } // down
      else if (di === 2) { arcStart =  Math.PI * 0.75; arcEnd =  Math.PI * 1.25; } // left
      else               { arcStart = -Math.PI * 0.25; arcEnd =  Math.PI * 0.25; } // right
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, Math.min(halfW, halfH) * 0.65, arcStart, arcEnd);
      ctx.closePath();
      ctx.fill();
    }

    // Arrow indicators
    ctx.fillStyle = 'rgba(255,255,255,' + (alpha + 0.3) + ')';
    ctx.font = (Math.min(dw, dh) * 0.22) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var arrowYOff = dh * 0.25;
    var arrowXOff = dw * 0.25;
    ctx.fillText('\u25B2', cx, cy - arrowYOff);      // ▲ up
    ctx.fillText('\u25BC', cx, cy + arrowYOff);      // ▼ down
    ctx.fillText('\u25C0', cx - arrowXOff, cy);      // ◀ left
    ctx.fillText('\u25B6', cx + arrowXOff, cy);      // ▶ right

    // Resize handles (edit mode)
    if (this._showHandles) {
      ctx.fillStyle = 'rgba(0,200,255,0.7)';
      var hSize = 8;
      // 4 corners
      var corners = [[dx, dy], [dx + dw, dy], [dx, dy + dh], [dx + dw, dy + dh]];
      for (var ci2 = 0; ci2 < 4; ci2++) {
        ctx.fillRect(corners[ci2][0] - hSize / 2, corners[ci2][1] - hSize / 2, hSize, hSize);
      }
    }

    // ── Action buttons ───────────────────────────────────────────
    for (var bi = 0; bi < this._buttons.length; bi++) {
      var b = this._buttons[bi];
      var bx = b.x * cw, by = b.y * ch, bw = b.w * cw, bh = b.h * ch;
      var bcx = bx + bw / 2, bcy = by + bh / 2;
      var bRadius = Math.min(bw, bh) / 2;

      // Button circle
      var btnAlpha = this._buttonStates[bi] ? 0.6 : alpha;
      ctx.fillStyle = 'rgba(255,255,255,' + btnAlpha + ')';
      ctx.strokeStyle = 'rgba(255,255,255,' + (btnAlpha + 0.2) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(bcx, bcy, bRadius * 0.9, bRadius * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Active glow
      if (this._buttonStates[bi]) {
        ctx.fillStyle = 'rgba(100,180,255,0.35)';
        ctx.beginPath();
        ctx.ellipse(bcx, bcy, bRadius * 0.85, bRadius * 0.85, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // Label
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = (bRadius * 0.9) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label || (bi + 1).toString(), bcx, bcy);

      // Resize handle (bottom-right corner, edit mode)
      if (this._showHandles) {
        ctx.fillStyle = 'rgba(0,200,255,0.7)';
        ctx.fillRect(bx + bw - hSize / 2, by + bh - hSize / 2, hSize, hSize);
      }
    }

    // ── Edit mode indicator ──────────────────────────────────────
    if (this._showHandles) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, cw, 24);
      ctx.fillStyle = 'rgba(0,200,255,0.9)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('Edit mode — drag to reposition, corner handles to resize. Tap empty area to exit.', 8, 12);
    }

    // Keep render loop alive if visible
    this._animId = requestAnimationFrame(this._render);
  };

  // ── helpers ───────────────────────────────────────────────────────────

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  // ── export ────────────────────────────────────────────────────────────

  global.TouchGamepad = TouchGamepad;

})(typeof window !== 'undefined' ? window : this);
