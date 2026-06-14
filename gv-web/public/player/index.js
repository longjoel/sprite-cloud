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
      }).catch(() => {
        // Browser blocked autoplay — user must tap
      });
      if (this.onTrack) {
        try { this.onTrack(event.track); } catch { /* safety */ }
      }
    };

    this._pc.addTransceiver("video", { direction: "recvonly" });
    this._pc.addTransceiver("audio", { direction: "recvonly" });

    // ── DataChannel (diagnostics) ────────────────────────────

    this._pc.ondatachannel = (event) => {
      this._dc = event.channel;
      this._dc.onmessage = (msgEvent) => {
        try {
          const msg = JSON.parse(msgEvent.data);
          this._handleDataChannelMessage(msg);
        } catch {
          // Ignore non-JSON (e.g., legacy raw "pong").
        }
      };
    };

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
            if (this._pendingPings.size > 20) {
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
    }, 2000);
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
      // DC send failed (channel closing)
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
    }
  }
}
