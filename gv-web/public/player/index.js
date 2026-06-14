// ── gv-player — browser-side WebRTC client ────────────────────────────
//
// Connects to a gv-worker, negotiates a WebRTC session, and renders
// the VP8 video stream.  Exported as a module for testing; a small
// bootstrap at the bottom auto-connects when loaded in a browser
// with a `?worker=` query parameter.

// ── Constants (no magic values) ───────────────────────────────────────

const STUN_SERVER = "stun:stun.l.google.com:19302";
const SDP_ENDPOINT = "/sdp";
const ICE_TIMEOUT_MS = 15_000;
const DISCONNECTED_GRACE_MS = 5_000;
const PING_INTERVAL_MS = 2000;
const MAX_PENDING_PINGS = 20;

// ── State machine ─────────────────────────────────────────────────────

export const State = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  ERROR: "error",
});

// ── GvPlayer ──────────────────────────────────────────────────────────

export class GvPlayer {
  /** @param {HTMLVideoElement} video — must be a <video> element */
  constructor(video) {
    if (!video || !video.tagName || video.tagName !== "VIDEO") {
      throw new TypeError("GvPlayer requires a <video> element");
    }
    this._video = video;
    this._video.autoplay = true;
    this._video.playsinline = true;

    /** @type {RTCPeerConnection | null} */
    this._pc = null;

    /** @type {RTCDataChannel | null} */
    this._dc = null;

    /** @type {string} */
    this._state = State.IDLE;

    /** @type {(state: string, detail?: string) => void} */
    this.onStateChange = null;

    /** @type {(track: MediaStreamTrack) => void} */
    this.onTrack = null;

    /** @type {(stats: object) => void} */
    this.onStats = null;

    /** @type {number | null} */
    this._iceTimer = null;

    /** @type {number | null} */
    this._disconnectedTimer = null;

    /** @type {number | null} */
    this._rttTimer = null;

    /** @private @type {object} */
    this._stats = { video: {}, audio: {}, pipeline: {} };

    /** @private @type {number | null} */
    this._rttMs = null;

    /** @private @type {number} */
    this._pingSeq = 0;

    /** @private @type {Map<number, number>} seq → performance.now() */
    this._pendingPings = new Map();
  }

  /** Current connection state (one of State.*). */
  get state() {
    return this._state;
  }

  /** Latest worker stats from DataChannel (or empty objects). */
  get stats() {
    return this._stats;
  }

  /** Latest RTT in milliseconds from DataChannel ping/pong (or null). */
  get rttMs() {
    return this._rttMs;
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Connect to a gv-worker at the given URL.
   * @param {string} workerUrl — e.g. "http://localhost:54321"
   */
  async connect(workerUrl) {
    if (this._state !== State.IDLE) {
      this.disconnect();
    }

    const url = this._normaliseUrl(workerUrl);
    this._setState(State.CONNECTING);

    this._pc = new RTCPeerConnection({
      iceServers: [{ urls: STUN_SERVER }],
    });

    this._pc.oniceconnectionstatechange = () => {
      // no state change — connection state handles it
    };

    this._pc.onconnectionstatechange = () => {
      const s = this._pc.connectionState;
      if (s === "connected") {
        this._setState(State.CONNECTED);
        this._clearIceTimer();
      } else if (s === "failed") {
        this._setState(State.ERROR, "connection failed");
        this._cleanup();
      } else if (s === "disconnected") {
        // Give ICE a grace period to recover before declaring error
        if (this._disconnectedTimer === null) {
          this._disconnectedTimer = setTimeout(() => {
            if (this._pc && this._pc.connectionState === "disconnected") {
              this._setState(State.ERROR, "disconnected (recovery timeout)");
              this._cleanup();
            }
          }, DISCONNECTED_GRACE_MS);
        }
      } else {
        // Connection is connecting, new, or connected — clear any
        // pending disconnect timeout.
        this._clearDisconnectedTimer();
      }
    };

    this._pc.ontrack = (event) => {
      if (!this._mediaStream) {
        this._mediaStream = new MediaStream();
        this._video.srcObject = this._mediaStream;
      }
      this._mediaStream.addTrack(event.track);
      // Mobile requires explicit play() call; start muted then unmute
      this._video.play().then(() => {
        this._video.muted = false;
      }).catch((e) => {
        console.debug("play() blocked:", e.message || e);
      });
      if (this.onTrack) {
        try { this.onTrack(event.track); } catch { /* safety */ }
      }
    };

    this._pc.addTransceiver("video", { direction: "recvonly" });
    this._pc.addTransceiver("audio", { direction: "recvonly" });

    // ── DataChannel (diagnostics) — create BEFORE offer ──────
    // The offerer must create the DataChannel so it appears in the
    // SDP offer. The worker (answerer) receives it via ondatachannel.
    this._dc = this._pc.createDataChannel("diagnostics");
    this._dc.onmessage = (msgEvent) => {
      try {
        const msg = JSON.parse(msgEvent.data);
        this._handleDataChannelMessage(msg);
      } catch {
        console.debug("DataChannel non-JSON message:", msgEvent.data?.slice?.(0, 80) || msgEvent.data);
      }
    };

    // ── Keyboard → DataChannel ─────────────────────────────────
    this._setupKeyboardInput();

    // ── RTT ping interval ────────────────────────────────────
    this._startPingInterval();

    // ── SDP exchange ──────────────────────────────────────────

    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);

    const sdpUrl = `${url}${SDP_ENDPOINT}`;
    const resp = await fetch(sdpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: offer.sdp }),
    });

    if (!resp.ok) {
      throw new Error(`SDP POST returned HTTP ${resp.status}`);
    }

    const answer = await resp.json();
    if (!answer.sdp) {
      throw new Error("SDP answer missing sdp field");
    }

    await this._pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp: answer.sdp }),
    );

    // ── ICE timeout watchdog ───────────────────────────────────

    this._iceTimer = setTimeout(() => {
      if (this._state !== State.CONNECTED) {
        this._setState(State.ERROR, "ICE gathering timed out");
        this._cleanup();
      }
    }, ICE_TIMEOUT_MS);
  }

  /** Tear down the peer connection. */
  disconnect() {
    this._clearIceTimer();
    this._clearDisconnectedTimer();
    this._stopPingInterval();
    if (this._dc) {
      this._dc.close();
      this._dc = null;
    }
    if (this._pc) {
      this._pc.close();
      this._pc = null;
    }
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(t => t.stop());
      this._mediaStream = null;
    }
    this._video.srcObject = null;
    this._stats = { video: {}, audio: {}, pipeline: {} };
    this._rttMs = null;
    this._pendingPings.clear();
    if (this._state === State.CONNECTED) {
      this._setState(State.IDLE);
    }
  }

  // ── Internal ────────────────────────────────────────────────────

  /** @param {string} state */
  _setState(state, detail) {
    if (state === this._state) return;
    this._state = state;
    if (this.onStateChange) {
      try { this.onStateChange(state, detail); } catch { /* safety */ }
    }
  }

  _cleanup() {
    this._clearIceTimer();
    this._clearDisconnectedTimer();
    this._stopPingInterval();
    this._removeKeyboardInput();
    if (this._dc) {
      this._dc.close();
      this._dc = null;
    }
    if (this._pc) {
      this._pc.close();
      this._pc = null;
    }
  }

  _clearIceTimer() {
    if (this._iceTimer !== null) {
      clearTimeout(this._iceTimer);
      this._iceTimer = null;
    }
  }

  _clearDisconnectedTimer() {
    if (this._disconnectedTimer !== null) {
      clearTimeout(this._disconnectedTimer);
      this._disconnectedTimer = null;
    }
  }

  /** @param {object} msg — parsed JSON from DataChannel */
  _handleDataChannelMessage(msg) {
    switch (msg.type) {
      case "stats":
        this._stats = msg;
        if (this.onStats) {
          try { this.onStats(msg); } catch { /* safety */ }
        }
        break;
      case "pong":
        {
          const seq = msg.seq;
          if (seq != null && this._pendingPings.has(seq)) {
            const sentAt = this._pendingPings.get(seq);
            this._pendingPings.delete(seq);
            this._rttMs = performance.now() - sentAt;
            // Clean up old entries to prevent unbounded growth
            if (this._pendingPings.size > MAX_PENDING_PINGS) {
              this._pendingPings.clear();
            }
          }
        }
        break;
    }
  }

  _startPingInterval() {
    this._stopPingInterval();
    // Send a ping every 2 seconds for RTT measurement
    this._rttTimer = setInterval(() => {
      this._sendPing();
    }, PING_INTERVAL_MS);
  }

  _sendPing() {
    if (!this._dc || this._dc.readyState !== "open") return;
    const seq = ++this._pingSeq;
    const clientTs = performance.now();
    this._pendingPings.set(seq, clientTs);
    try {
      this._dc.send(JSON.stringify({
        cmd: "ping",
        seq: seq,
        client_ts: clientTs,
      }));
    } catch {
      console.warn("DC send(ping) failed — channel closing");
    }
  }

  _stopPingInterval() {
    if (this._rttTimer !== null) {
      clearInterval(this._rttTimer);
      this._rttTimer = null;
    }
  }

  /** @param {string} raw */
  _normaliseUrl(raw) {
    let u = raw.trim();
    if (!/^https?:\/\//i.test(u)) {
      u = `http://${u}`;
    }
    return u.replace(/\/+$/, "");
  }

  // ── Keyboard input (RetroArch binary mask format) ──────────
  /** Accumulates key state into a 16-bit RetroArch joypad mask
   *  and sends binary [u8 seat][u16 LE state] on every change.
   *  Bit layout: Up=4, Down=5, Left=6, Right=7, Start=3,
   *  Select=2, B=0, A=8. See ADR 008. */
  _setupKeyboardInput() {
    const BIT_MAP = {
      ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7,
      w: 4, a: 6, s: 5, d: 7,
      z: 0, x: 8,           // B, A
      Enter: 3, ' ': 3,     // Start
      Shift: 2,             // Select
    };

    this._inputState = 0;

    const sendMask = () => {
      if (!this._dc || this._dc.readyState !== "open") return;
      try {
        const s = this._inputState;
        this._dc.send(new Uint8Array([0, s & 0xFF, s >> 8]).buffer);
      } catch { /* channel closing */ }
    };

    const handler = (e) => {
      const bit = BIT_MAP[e.key];
      if (bit === undefined) return;
      e.preventDefault();
      if (e.type === "keydown") {
        this._inputState |= (1 << bit);
      } else {
        this._inputState &= ~(1 << bit);
      }
      sendMask();
    };

    this._keyHandler = handler;
    document.addEventListener("keydown", handler);
    document.addEventListener("keyup", handler);

    // Reset state on blur (stuck keys if user tabs away)
    this._blurHandler = () => { this._inputState = 0; sendMask(); };
    window.addEventListener("blur", this._blurHandler);
  }

  _removeKeyboardInput() {
    if (this._keyHandler) {
      document.removeEventListener("keydown", this._keyHandler);
      document.removeEventListener("keyup", this._keyHandler);
      this._keyHandler = null;
    }
    if (this._blurHandler) {
      window.removeEventListener("blur", this._blurHandler);
      this._blurHandler = null;
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────
}

// ── Auto-connect bootstrap (browser only) ──────────────────────────────

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const params = new URLSearchParams(location.search);
  const workerParam = params.get("worker");

  if (workerParam) {
    const video = /** @type {HTMLVideoElement} */ (document.getElementById("video"));
    if (video) {
      const player = new GvPlayer(video);

      const statusEl = document.getElementById("status");

      player.onStateChange = (state, detail) => {
        if (statusEl) {
          statusEl.textContent = state + (detail ? `: ${detail}` : "");
          if (state === State.ERROR) statusEl.classList.add("error");
        }
      };

      player.connect(workerParam).catch((err) => {
        if (statusEl) {
          statusEl.textContent = `error: ${err.message || err}`;
          statusEl.classList.add("error");
        }
      });

      // Expose for debugging (console access)
      window.gvPlayer = player;
    }
  }
}
