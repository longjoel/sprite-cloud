// ── gv-player — browser-side WebRTC client ────────────────────────────
//
// Connects to a gv-worker, negotiates a WebRTC session, and renders
// the VP8 video stream.  Exported as a module for testing; a small
// bootstrap at the bottom auto-connects when loaded in a browser
// with a `?worker=` query parameter.

// ── Constants (no magic values) ───────────────────────────────────────


// ── Route classification ────────────────────────────────────────────────

/**
 * Classify a WebRTC route from getStats() selected candidate pair.
 *
 * @param {{ localCandidateType?: string, remoteCandidateType?: string }} pair
 * @param {string} connectionState — RTCPeerConnection.connectionState
 * @returns {{ route: string, detail: string }}
 *
 * route values:
 *   "local"   — both candidates are host/private IPs
 *   "direct"  — server-reflexive on either side, no relay
 *   "relay"   — relay candidate on either side
 *   "failed"  — ICE failed
 *   "unknown" — connected but stats unavailable
 */
export function classifyRoute(pair, connectionState) {
  if (connectionState === "failed") {
    return { route: "failed", detail: "ICE failed" };
  }

  const local = (pair && pair.localCandidateType) || "";
  const remote = (pair && pair.remoteCandidateType) || "";

  if (!local && !remote) {
    return { route: "unknown", detail: "no candidate stats" };
  }

  if (local === "relay" || remote === "relay") {
    return { route: "relay", detail: "TURN relay" };
  }

  if (local === "srflx" || remote === "srflx") {
    return { route: "direct", detail: "STUN direct" };
  }

  // Both host candidates
  return { route: "local", detail: "LAN host" };
}

/**
 * Inspect a connected RTCPeerConnection and classify the route.
 * Returns null if getStats() fails (non-critical).
 *
 * @param {RTCPeerConnection} pc
 * @returns {Promise<{route: string, detail: string} | null>}
 */
export async function inspectRoute(pc) {
  if (!pc || pc.connectionState !== "connected") return null;

  try {
    const stats = await pc.getStats();
    let selectedPair = null;

    for (const r of stats.values()) {
      if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) {
        selectedPair = r;
        break;
      }
    }

    // Fallback: any succeeded pair
    if (!selectedPair) {
      for (const r of stats.values()) {
        if (r.type === "candidate-pair" && r.state === "succeeded") {
          selectedPair = r;
          break;
        }
      }
    }

    // Resolve local/remote candidate types from stats
    let localCandidateType = "";
    let remoteCandidateType = "";

    if (selectedPair) {
      const localCand = stats.get(selectedPair.localCandidateId);
      const remoteCand = stats.get(selectedPair.remoteCandidateId);
      localCandidateType = (localCand && localCand.candidateType) || "";
      remoteCandidateType = (remoteCand && remoteCand.candidateType) || "";
    }

    return classifyRoute(
      { localCandidateType, remoteCandidateType },
      pc.connectionState || "connected"
    );
  } catch (e) {
    console.warn("[gv] getStats() failed for route inspection:", e?.message || e);
    return { route: "unknown", detail: "stats unavailable" };
  }
}

function gvCsrfHeaders() {
  let token = document.cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("gv_csrf_token="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!token) {
    token = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    document.cookie = `gv_csrf_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  }
  return { "Content-Type": "application/json", "x-csrf-token": decodeURIComponent(token) };
}

const SDP_ENDPOINT = "/sdp";
const ICE_TIMEOUT_MS = 15_000;
const ICE_CONNECT_TIMEOUT_MS = 60_000;
const DISCONNECTED_GRACE_MS = 5_000;
const PING_INTERVAL_MS = 2000;
const MAX_PENDING_PINGS = 20;

/** Poll interval when waiting for relay SDP answer (ms). */
const RELAY_POLL_MS = 500;
/** Max time to wait for relay SDP answer (ms). */
const RELAY_TIMEOUT_MS = 30_000;

/** Bits in the RetroArch mask that the gamepad can set.
 *  Keyboard and gamepad share the same mask; gamepad-owned bits
 *  are cleared each frame so keyboard presses persist across
 *  gamepad poll frames.
 *
 *  Bit layout: B=0, Y=1, Select=2, Start=3, Up=4, Down=5,
 *  Left=6, Right=7, A=8, X=9, L=10, R=11, L2=12, R2=13,
 *  L3=14, R3=15 (RetroArch RETRO_DEVICE_ID_JOYPAD_*).
 *
 *  KEEP IN SYNC with the canonical source:
 *  libretro-runner/src/lib.rs — JoypadButton enum. */
const GAMEPAD_MASK = (1 << 0) | (1 << 2) | (1 << 3) | (1 << 4)
                   | (1 << 5) | (1 << 6) | (1 << 7) | (1 << 8);

/**
 * Default gamepad button mapping for the standard layout
 * (https://w3c.github.io/gamepad/#remapping).
 *
 * Each property maps a logical action to the button index in the
 * Gamepad.buttons array for standard-mapped controllers.
 *
 * Override by passing `gamepadMapping` in GvPlayer constructor
 * options to support non-standard controllers (8BitDo in
 * DirectInput mode, fight sticks, etc.).
 *
 * @typedef {{ dpadUp: number, dpadDown: number, dpadLeft: number,
 *             dpadRight: number, start: number, select: number,
 *             a: number, b: number, leftStickX: number,
 *             leftStickY: number, axisThreshold: number }} GamepadMapping
 */
const DEFAULT_GAMEPAD_MAPPING = Object.freeze({
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  start: 9,
  select: 8,
  a: 0,           // cross / bottom face button
  b: 1,           // circle / right face button
  leftStickX: 0,  // axis index for horizontal
  leftStickY: 1,  // axis index for vertical
  axisThreshold: 0.5,
});

// ── State machine ─────────────────────────────────────────────────────

export const State = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  ERROR: "error",
});

// ── GvPlayer ──────────────────────────────────────────────────────────

export class GvPlayer {
  /** @param {HTMLVideoElement} video — must be a <video> element
   *  @param {{ iceServers?: Array<{urls: string|string[], username?: string, credential?: string}>, seat?: number, iceTimeout?: number, disconnectedGrace?: number, gamepadMapping?: import('./index.js').GamepadMapping }} [options] */
  constructor(video, options) {
    if (!video || !video.tagName || video.tagName !== "VIDEO") {
      throw new TypeError("GvPlayer requires a <video> element");
    }
    this._video = video;
    this._video.autoplay = true;
    this._video.playsinline = true;

    /** @type {Array<{urls: string|string[], username?: string, credential?: string}>} */
    this._iceServers = (options && options.iceServers) || [];
    this._iceTransportPolicy = (options && options.iceTransportPolicy) || "all";

    /** @type {number} Player seat index (0 = default, 1–N for multi-seat). */
    this._seat = (options && typeof options.seat === "number") ? options.seat : 0;

    /** @type {number} ICE gathering timeout in ms. */
    this._iceTimeout = (options && typeof options.iceTimeout === "number") ? options.iceTimeout : ICE_TIMEOUT_MS;

    /** @type {number} Grace period in ms before declaring connection lost after ICE disconnect. */
    this._disconnectedGrace = (options && typeof options.disconnectedGrace === "number") ? options.disconnectedGrace : DISCONNECTED_GRACE_MS;

    /** @type {import('./index.js').GamepadMapping} Button indices for gamepad mapping.
     *  Override via options.gamepadMapping for non-standard controllers. */
    this._gamepadMapping = (options && options.gamepadMapping) || DEFAULT_GAMEPAD_MAPPING;

    /** @type {RTCPeerConnection | null} */
    this._pc = null;

    /** @type {RTCDataChannel | null} */
    this._dc = null;

    /** @private @type {number} timestamp of connectViaRelay start */
    this._connectStart = 0;

    /** @type {string} */
    this._state = State.IDLE;

    /** @type {(state: string, detail?: string) => void} */
    this.onStateChange = null;

    /** @type {(track: MediaStreamTrack) => void} */
    this.onTrack = null;

    /** @type {(stats: object) => void} */
    this.onStats = null;

    /** @type {({slot: number, ok: boolean}) => void} */
    this.onSaveResult = null;

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

    /** @private @type {{route: string, detail: string} | null} */
    this._route = null;

    /** @type {(route: string, detail: string) => void} */
    this._onRoute = null;

    // ── Gamepad state ──────────────────────────────────────────────
    /** @private @type {boolean} */
    this._gamepadActive = false;
    /** @private @type {number} last raw gamepad mask */
    this._gamepadState = 0;
    /** @private @type {number | null} rAF handle for gamepad poll */
    this._gamepadRAF = null;

    /** @private @type {boolean} play deferred until user gesture (Safari iOS) */
    this._playbackDeferred = false;
    /** @private @type {Function | null} bound gesture handler */
    this._gestureHandler = null;
  }

  /**
   * Log a connection phase with elapsed time since connectViaRelay start.
   * Format: [gv] +1234ms phase:state key=value ...
   * @param {string} phase  — e.g. "gather", "relay", "remote", "conn", "media"
   * @param {string} state  — e.g. "done", "answer", "set", "connected", "video"
   * @param {object} [extra] — additional key=value pairs
   */
  _phaseLog(phase, state, extra) {
    const elapsed = Date.now() - (this._connectStart || Date.now());
    const parts = [`[gv] +${String(elapsed).padStart(4)}ms ${phase}:${state}`];
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        parts.push(`${k}=${v}`);
      }
    }
    console.log(parts.join(" "));
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
   * Connect to a gv-worker at the given URL (direct path — dev only).
   * @param {string} workerUrl — e.g. "http://localhost:54321"
   */
  async connect(workerUrl) {
    if (this._state !== State.IDLE) {
      this.disconnect();
    }

    const url = this._normaliseUrl(workerUrl);
    this._setState(State.CONNECTING);

    this._createPeerConnection();

    // ── SDP exchange (direct to worker) ──────────────────────────

    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    await this._waitForIceGatheringComplete();

    const sdpUrl = `${url}${SDP_ENDPOINT}`;
    const resp = await fetch(sdpUrl, {
      method: "POST",
      headers: gvCsrfHeaders(),
      body: JSON.stringify({ sdp: this._pc.localDescription?.sdp || offer.sdp }),
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
        this._setState(State.ERROR, "ICE connection timed out");
        this._cleanup();
      }
    }, ICE_CONNECT_TIMEOUT_MS);
  }

  /**
   * Connect through the signaling relay.
   *
   * 1. Creates peer connection + DataChannel + keyboard/gamepad
   * 2. POSTs sdp_offer to /api/server/command (gets worker_token)
   * 3. Polls /api/server/notify for the worker's SDP answer
   * 4. Sets the remote description — WebRTC media flows directly
   *
   * @param {string} serverId   — server UUID
   * @param {string} gameId     — game identifier
   * @param {string} hostToken  — host reconnection token
   * @param {string} pollToken  — worker_token for answer polling
   * @param {string} [roomToken]— room token for guest joins
   * @param {string} [peerToken]— peer auth token
   */
  async connectViaRelay(serverId, gameId, hostToken, pollToken, roomToken, peerToken) {
    this._connectStart = Date.now();
    this._phaseLog("relay", "connecting", { gameId: gameId.slice(0,8) });

    if (this._state !== State.IDLE) {
      this.disconnect();
    }

    this._setState(State.CONNECTING);

    // Store tokens for DataChannel auth and SDP payload
    this._hostToken = hostToken || null;
    this._peerToken = peerToken || null;

    this._createPeerConnection();

    // ── SDP exchange (via relay) ──────────────────────────────────

    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    const gatherStart = Date.now();
    await this._waitForIceGatheringComplete();
    this._phaseLog("gather", "done", { ms: Date.now() - gatherStart });

    // POST sdp_offer command — returns a worker_token we use to poll
    const cmdBody = {
      server_id: serverId,
      type: "sdp_offer",
      payload: { game_id: gameId, sdp: this._pc.localDescription?.sdp || offer.sdp, host_token: hostToken },
    };
    if (roomToken) {
      cmdBody.payload.room_token = roomToken;
    }
    if (peerToken) {
      cmdBody.payload.peer_token = peerToken;
    }
    const cmdResp = await fetch("/api/server/command", {
      method: "POST",
      headers: gvCsrfHeaders(),
      body: JSON.stringify(cmdBody),
    });

    if (!cmdResp.ok) {
      const errData = await cmdResp.json().catch(() => ({}));
      throw new Error(
        `sdp_offer POST failed: HTTP ${cmdResp.status} — ${errData.error || "unknown"}`,
      );
    }

    const cmdData = await cmdResp.json();
    const workerToken = cmdData.worker_token;
    if (!workerToken) {
      throw new Error("sdp_offer response missing worker_token");
    }

    // Poll for the worker's SDP answer.
    // Use the start_game pollToken if available (ties to the session),
    // otherwise fall back to the sdp_offer's workerToken.
    const pollStart = Date.now();
    let answerSdp = await this._pollForAnswer(serverId, pollToken || workerToken);
    this._phaseLog("relay", "answer", { ms: Date.now() - pollStart, chars: answerSdp.length });

    // Normalize extmap: webrtc-rs 0.17.1 sometimes assigns different extmap IDs
    // than the offer (e.g. video-timing at id=7 when offer used id=7 for TWCC).
    // Chrome rejects setRemoteDescription on extmap ID collisions.
    // Strip all a=extmap lines from the answer — Chrome falls back to the offer's
    // extmap mappings, and the worker doesn't need RTP header extensions for
    // basic video streaming.
    answerSdp = answerSdp
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("a=extmap:"))
      .join("\n");

    await this._pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp: answerSdp }),
    );
    this._phaseLog("remote", "set", { ms: Date.now() - this._connectStart });

    // ── ICE timeout watchdog ───────────────────────────────────

    this._iceTimer = setTimeout(() => {
      if (this._state !== State.CONNECTED) {
        this._setState(State.ERROR, "ICE connection timed out");
        this._cleanup();
      }
    }, ICE_CONNECT_TIMEOUT_MS);
  }

  /** Tear down the peer connection. */
  disconnect() {
    this._clearIceTimer();
    this._clearDisconnectedTimer();
    this._stopPingInterval();
    this._removeKeyboardInput();
    this._removeGamepadInput();
    // Remove Safari iOS deferred-play gesture listener
    if (this._gestureHandler) {
      document.removeEventListener("pointerdown", this._gestureHandler, true);
      document.removeEventListener("touchstart", this._gestureHandler, true);
      document.removeEventListener("keydown", this._gestureHandler, true);
      this._gestureHandler = null;
    }
    this._playbackDeferred = false;
    // Detach event handlers before closing to prevent stale callbacks
    // from firing on a null this._pc / this._dc after reconnect.
    if (this._dc) {
      this._dc.onmessage = null;
      this._dc.onopen = null;
      this._dc.close();
      this._dc = null;
    }
    if (this._pc) {
      this._pc.onconnectionstatechange = null;
      this._pc.oniceconnectionstatechange = null;
      this._pc.ontrack = null;
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

  /**
   * Create the RTCPeerConnection, DataChannel, and input handlers.
   * Shared by both connect() and connectViaRelay().
   * @private
   */
  _createPeerConnection() {
    console.log("[gv] _createPeerConnection: iceServers=", this._iceServers?.length, "items, policy=", this._iceTransportPolicy);
    if (this._iceServers?.length) {
      this._iceServers.forEach((s, i) => {
        console.log("[gv]   server[" + i + "]: urls=" + JSON.stringify(s.urls) + " user=" + (s.username || "none"));
      });
    }
    this._pc = new RTCPeerConnection({
      iceServers: this._iceServers,
      iceTransportPolicy: this._iceTransportPolicy,
    });

    this._pc.oniceconnectionstatechange = () => {
      // no state change — connection state handles it
    };

    this._pc.onconnectionstatechange = () => {
      const s = this._pc.connectionState;
      this._phaseLog("conn", s, { ms: Date.now() - (this._connectStart || Date.now()) });
      if (s === "connected") {
        this._setState(State.CONNECTED);
        this._clearIceTimer();
        // Inspect the WebRTC route asynchronously (non-blocking)
        inspectRoute(this._pc).then((info) => {
          if (info) {
            this._route = info;
            console.log("[gv] route:", info.route, info.detail);
            if (this._onRoute) this._onRoute(info.route, info.detail);
          }
        });
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
          }, this._disconnectedGrace);
        }
      } else {
        // Connection is connecting, new, or connected — clear any
        // pending disconnect timeout.
        this._clearDisconnectedTimer();
      }
    };

    this._pc.ontrack = (event) => {
      this._phaseLog("media", event.track?.kind || "track", { ms: Date.now() - (this._connectStart || Date.now()) });
      if (!this._mediaStream) {
        this._mediaStream = new MediaStream();
        this._video.srcObject = this._mediaStream;
      }
      this._mediaStream.addTrack(event.track);

      // Defer play until a user gesture (required by Safari iOS).
      // On desktop, play() succeeds immediately; on iOS it fails
      // and the gesture handler picks it up.
      this._playbackDeferred = true;
      this._video.play().then(() => {
        this._playbackDeferred = false;
        this._video.muted = false;
        console.log("[gv] audio unmuted");
      }).catch((e) => {
        console.debug("play() deferred — waiting for user gesture:", e.message || e);
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

    // Flush any accumulated input state and send auth when the DataChannel opens
    this._dc.onopen = () => {
      // Send auth message first — must be the first message on the channel
      const authCmd = { cmd: "auth" };
      if (this._peerToken) authCmd.peer_token = this._peerToken;
      if (this._hostToken && !this._peerToken) authCmd.host_token = this._hostToken;
      if (authCmd.peer_token || authCmd.host_token) {
        try {
          this._dc.send(JSON.stringify(authCmd));
        } catch (e) {
          console.warn("[DC] auth send failed:", e?.message || e, "— DC closing");
          this._dc.close();
        }
      }
      if (this._sendMask) this._sendMask();
    };

    // ── Input ─────────────────────────────────────────────────
    this._setupKeyboardInput();
    this._setupGamepadInput();

    // ── Safari iOS deferred play ──────────────────────────────
    const deferredPlay = () => {
      if (!this._playbackDeferred) return;
      this._playbackDeferred = false;
      this._video.play().then(() => {
        this._video.muted = false;
      }).catch((e) => {
        console.debug("deferred play() still blocked:", e.message || e);
      });
      // Remove the gesture listener after first successful trigger
      if (this._gestureHandler) {
        document.removeEventListener("pointerdown", this._gestureHandler, true);
        document.removeEventListener("touchstart", this._gestureHandler, true);
        document.removeEventListener("keydown", this._gestureHandler, true);
        this._gestureHandler = null;
      }
    };
    // Capture phase so we catch events even on child elements
    this._gestureHandler = deferredPlay;
    document.addEventListener("pointerdown", deferredPlay, true);
    document.addEventListener("touchstart", deferredPlay, true);
    document.addEventListener("keydown", deferredPlay, true);

    // ── RTT ping interval ────────────────────────────────────
    this._startPingInterval();
    return this._pc;
  }

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
    this._removeGamepadInput();
    // Remove Safari iOS deferred-play gesture listener
    if (this._gestureHandler) {
      document.removeEventListener("pointerdown", this._gestureHandler, true);
      document.removeEventListener("touchstart", this._gestureHandler, true);
      document.removeEventListener("keydown", this._gestureHandler, true);
      this._gestureHandler = null;
    }
    this._playbackDeferred = false;
    if (this._dc) {
      this._dc.onmessage = null;
      this._dc.onopen = null;
      this._dc.close();
      this._dc = null;
    }
    // Clean media stream — stale tracks poison reconnects.
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(t => t.stop());
      this._mediaStream = null;
    }
    this._video.srcObject = null;
    if (this._pc) {
      this._pc.onconnectionstatechange = null;
      this._pc.oniceconnectionstatechange = null;
      this._pc.ontrack = null;
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

  async _waitForIceGatheringComplete() {
    if (!this._pc) {
      console.warn("[gv] _waitForIceGatheringComplete: no pc, returning");
      return;
    }
    if (this._pc.iceGatheringState === "complete") {
      console.log("[gv] _waitForIceGatheringComplete: already complete");
      return;
    }

    const isRelayOnly = this._iceTransportPolicy === "relay";
    const timeout = isRelayOnly ? 60_000 : this._iceTimeout;

    console.log("[gv] _waitForIceGatheringComplete: waiting (state=" + this._pc.iceGatheringState + ", timeout=" + timeout + "ms, relay=" + isRelayOnly + ")");

    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 250));
      if (!this._pc) {
        console.warn("[gv] _waitForIceGatheringComplete: pc nulled during wait");
        return;
      }
      const st = this._pc.iceGatheringState;
      if (st === "complete") {
        // For relay-only, also verify the SDP actually contains candidates.
        // Chrome may report "complete" before adding relay candidates to the SDP.
        if (isRelayOnly) {
          const sdp = this._pc.localDescription?.sdp || "";
          if (!sdp.includes("a=candidate:")) {
            continue; // still waiting for relay candidate in SDP
          }
        }
        console.log("[gv] _waitForIceGatheringComplete: complete after " + (Date.now() - start) + "ms");
        return;
      }
    }

    console.warn("[gv] _waitForIceGatheringComplete: timed out after " + timeout + "ms (state=" + (this._pc?.iceGatheringState || "null") + "), sending partial offer");
  }

  /**
   * Poll GET /api/server/notify until sdp_answer is available.
   * @private
   * @param {string} serverId
   * @param {string} workerToken
   * @returns {Promise<string>} the SDP answer
   */
  async _pollForAnswer(serverId, workerToken) {
    const start = Date.now();

    while (Date.now() - start < RELAY_TIMEOUT_MS) {
      const resp = await fetch(
        `/api/server/notify?server_id=${encodeURIComponent(serverId)}&worker_token=${encodeURIComponent(workerToken)}`,
      );
      if (!resp.ok) {
        throw new Error(`Notify poll failed: HTTP ${resp.status}`);
      }
      const data = await resp.json();
      if (data.sdp_answer) {
        if (data.room_token) this._roomToken = data.room_token;
        return data.sdp_answer;
      }
      await new Promise(r => setTimeout(r, RELAY_POLL_MS));
    }
    throw new Error("Timed out waiting for SDP answer from relay");
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
      case "save_result":
        if (this.onSaveResult) {
          try {
            this.onSaveResult({ slot: msg.slot, ok: msg.ok });
          } catch { /* safety */ }
        }
        break;
      case "core_died":
      case "error":
        {
          const reason = msg.reason || msg.message || "Unknown error";
          console.error("[gv-player] Fatal:", reason);
          this._transition(State.ERROR);
          this.disconnect();
          if (this.onError) {
            try { this.onError(reason); } catch { /* safety */ }
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
   *  Select=2, B=0, A=8.
   *  KEEP IN SYNC: libretro-runner/src/lib.rs — JoypadButton enum. */
  _setupKeyboardInput() {
    // Full 16-bit default mapping.
    // Bits: B=0, Y=1, Select=2, Start=3, Up=4, Down=5, Left=6, Right=7,
    //       A=8, X=9, L=10, R=11, L2=12, R2=13, L3=14, R3=15
    const DEFAULT_BIT_MAP = Object.freeze({
      // D-pad
      ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7,
      w: 4, a: 6, s: 5, d: 7,
      // Face buttons (SNES layout: B=bottom, A=right, Y=left, X=top)
      z: 0, x: 8,                 // B, A
      c: 9, v: 1,                 // X, Y
      // Shoulder
      f: 10, g: 11,               // L, R
      r: 12, t: 13,               // L2, R2
      // Start / Select
      q: 3, e: 2,
      Enter: 3, ' ': 3,
      Shift: 2,                   // Select
    });

    // Load saved remapping from localStorage, fall back to defaults
    let BIT_MAP = { ...DEFAULT_BIT_MAP };
    try {
      const saved = localStorage.getItem("gv-keymap");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === "object") {
          Object.assign(BIT_MAP, parsed);
        }
      }
    } catch (_) { /* ignore corrupt storage */ }

    // Expose for remapping UI
    this._bitMap = BIT_MAP;
    this._defaultBitMap = DEFAULT_BIT_MAP;

    /** @returns {Record<string, number>} current key→bit mapping */

    this._inputState = 0;

    const sendMask = () => {
      if (!this._dc || this._dc.readyState !== "open") {
        // DC not open yet — silently skip (this fires every frame during connect)
        return;
      }
      try {
        const s = this._inputState;
        this._dc.send(new Uint8Array([this._seat, s & 0xFF, s >> 8]).buffer);
      } catch (e) {
        console.warn("[INPUT] sendMask failed — DC may be closed:", e?.message || e);
        // Close the DC so the reconnect flow picks up the failure
        if (this._dc) this._dc.close();
      }
    };
    // Expose sendMask so gamepad can reuse the same DataChannel sender
    this._sendMask = sendMask;

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
    // Expose getter for remap UI
    /** @returns {Record<string, number>} */
    this.getKeyMapping = () => BIT_MAP;

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

  // ── Gamepad input ───────────────────────────────────────────
  /**
   * Poll navigator.getGamepads() on every rAF frame and merge
   * gamepad state into the shared RetroArch joypad mask.
   * Keyboard bits are preserved — gamepad only touches GAMEPAD_MASK bits.
   *
   * Button → bit mapping (KEEP IN SYNC with
   * libretro-runner/src/lib.rs — JoypadButton enum):
   *   Up=4, Down=5, Left=6, Right=7, Start=3, Select=2, A=8, B=0
   * @private
   */
  _setupGamepadInput() {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return;

    this._gamepadActive = true;
    this._gamepadState = 0;

    const poll = () => {
      if (!this._gamepadActive) return;

      const gp = navigator.getGamepads()?.[0];
      if (!gp) {
        this._gamepadRAF = requestAnimationFrame(poll);
        return;
      }

      let state = 0;
      const m = this._gamepadMapping;
      // D-pad: use configured button indices; fall back to left stick axes
      if (gp.buttons[m.dpadUp]?.pressed    || gp.axes[m.leftStickY] < -m.axisThreshold) state |= (1 << 4); // Up
      if (gp.buttons[m.dpadDown]?.pressed  || gp.axes[m.leftStickY] >  m.axisThreshold) state |= (1 << 5); // Down
      if (gp.buttons[m.dpadLeft]?.pressed  || gp.axes[m.leftStickX] < -m.axisThreshold) state |= (1 << 6); // Left
      if (gp.buttons[m.dpadRight]?.pressed || gp.axes[m.leftStickX] >  m.axisThreshold) state |= (1 << 7); // Right

      // Face / shoulder / start / select — use configured button indices
      if (gp.buttons[m.start]?.pressed)  state |= (1 << 3); // Start
      if (gp.buttons[m.select]?.pressed) state |= (1 << 2); // Select
      if (gp.buttons[m.a]?.pressed)      state |= (1 << 8); // A (cross / bottom)
      if (gp.buttons[m.b]?.pressed)      state |= (1 << 0); // B (circle / right)

      if (state !== this._gamepadState) {
        this._gamepadState = state;
        // Merge: keep keyboard bits, replace gamepad-owned bits
        this._inputState = (this._inputState & ~GAMEPAD_MASK) | state;
        this._sendMask?.();
      }
      this._gamepadRAF = requestAnimationFrame(poll);
    };
    this._gamepadRAF = requestAnimationFrame(poll);
  }

  _removeGamepadInput() {
    this._gamepadActive = false;
    if (this._gamepadRAF !== null) {
      cancelAnimationFrame(this._gamepadRAF);
      this._gamepadRAF = null;
    }
  }

  // ── Key remapping ────────────────────────────────────────────

  /** Update a key mapping and persist to localStorage. */
  setKeyMapping(key, bit) {
    this._bitMap[key] = bit;
    try {
      localStorage.setItem("gv-keymap", JSON.stringify(this._bitMap));
    } catch (_) { /* ignore */ }
  }

  /** Reset all key mappings to defaults. */
  resetKeymap() {
    this._bitMap = { ...this._defaultBitMap };
    try { localStorage.removeItem("gv-keymap"); } catch (_) {}
    return this._bitMap;
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
        console.error("[gv] auto-connect failed:", err?.message || err, err?.stack);
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
