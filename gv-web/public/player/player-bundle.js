// ── gv-player — browser-side WebRTC client ────────────────────────────
//
// Connects to the gv-server host runtime, negotiates a WebRTC session, and renders
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
const RELAY_POLL_MS = 100;
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

    /** @type {boolean} play deferred until user gesture (Safari iOS) */
    this._playbackDeferred = false;
    /** @private @type {Function | null} bound gesture handler */
    this._gestureHandler = null;

    // ── Status overlay ─────────────────────────────────────────────────
    /** @private @type {HTMLDivElement | null} injected overlay */
    this._statusOverlay = null;
    /** @private @type {NodeJS.Timeout | null} timer for clearing temporary status */
    this._statusTimer = null;
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

  // ── Status overlay ──────────────────────────────────────────────────

  /**
   * Inject or return the status overlay <div>. Creates it lazily on first call.
   * @returns {HTMLDivElement}
   */
  _ensureOverlay() {
    if (this._statusOverlay) return this._statusOverlay;
    const div = document.createElement("div");
    div.id = "gv-status";
    Object.assign(div.style, {
      position: "absolute",
      inset: "0",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(26,20,16,0.85)",
      color: "#e8dcc8",
      fontFamily: "\"Geist Mono\", \"Fira Code\", monospace",
      fontSize: "16px",
      zIndex: "10",
      pointerEvents: "none",
    });
    // Inject into the video's parent, positioned over the video
    const video = this._video;
    if (video.parentElement) {
      video.parentElement.style.position =
        video.parentElement.style.position || "relative";
      video.parentElement.appendChild(div);
    } else {
      video.insertAdjacentElement("afterend", div);
    }
    this._statusOverlay = div;
    return div;
  }

  /**
   * Set the overlay message. Shows the overlay with the given text and
   * optional style overrides. Pass message="" to hide.
   * @param {string} message — status text (empty to hide)
   * @param {{ color?: string, spinner?: boolean }} [opts]
   */
  _showStatus(message, opts) {
    const overlay = this._ensureOverlay();
    if (this._statusTimer) { clearTimeout(this._statusTimer); this._statusTimer = null; }
    if (!message) {
      overlay.style.display = "none";
      return;
    }
    overlay.textContent = opts?.spinner ? message + "\u2026" : message;
    overlay.style.display = "flex";
    if (opts?.color) overlay.style.color = opts.color;
    else overlay.style.color = "#e8dcc8";
  }

  /**
   * Show a temporary status message that auto-clears after `ms` milliseconds.
   * @param {string} message
   * @param {number} ms
   */
  _flashStatus(message, ms) {
    this._showStatus(message);
    if (this._statusTimer) clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => this._showStatus(""), ms);
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
   * Connect to the host runtime at the given URL (direct path — dev only).
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
  async connectViaRelay(serverId, gameId, hostToken, pollToken, roomToken, peerToken, sdpAnswer) {
    this._connectStart = Date.now();
    this._phaseLog("relay", "connecting", { gameId: gameId.slice(0,8) });

    if (this._state !== State.IDLE) {
      this.disconnect();
    }

    this._setState(State.CONNECTING);

    // Store tokens for DataChannel auth and SDP payload
    this._hostToken = hostToken || null;
    this._peerToken = peerToken || null;

    // ── SDP exchange ──────────────────────────────────────────────

    if (sdpAnswer) {
      // Pre-baked answer from start_game (host path) — PC already has
      // local description set by the caller. Just set remote.
      this._phaseLog("relay", "prebaked-answer", { chars: sdpAnswer.length });
      const normalized = sdpAnswer
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("a=extmap:"))
        .join("\n");
      await this._pc.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: normalized }),
      );
      this._phaseLog("remote", "set", { ms: Date.now() - this._connectStart });
    } else {
      // Original flow: create offer, POST sdp_offer, poll for answer
      this._createPeerConnection();

      const offer = await this._pc.createOffer();
      await this._pc.setLocalDescription(offer);
      const gatherStart = Date.now();
      await this._waitForIceGatheringComplete();
      this._phaseLog("gather", "done", { ms: Date.now() - gatherStart });

      // POST sdp_offer command — returns a worker_token we use to poll
      const cmdBody = {
        server_id: serverId,
        type: "sdp_offer",
        payload: { game_id: gameId, sdp: this._pc.localDescription?.sdp || offer.sdp },
      };
      if (hostToken) {
        cmdBody.payload.host_token = hostToken;
      }
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
    }

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
      // Count connected gamepads for local_players seat offset
      // Minimum 1 (keyboard on seat 0), maximum capped at 4 (libretro port limit)
      let localPlayers = 1;
      try {
        const gps = navigator.getGamepads();
        if (gps) {
          let count = 0;
          const names = [];
          for (const gp of gps) {
            if (gp) { count++; names.push(gp.id); }
          }
          localPlayers = Math.max(1, Math.min(count, 4));
          console.log("[GPAD] auth: found", count, "gamepad(s):", names.join(", "), "→ local_players =", localPlayers);
        } else {
          console.log("[GPAD] auth: navigator.getGamepads() returned null");
        }
      } catch (_) {
        console.warn("[GPAD] auth: getGamepads threw — Gamepad API not available");
      }

      // Send auth message first — must be the first message on the channel
      const authCmd = { cmd: "auth", local_players: localPlayers };
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
    // Update the on-screen overlay
    switch (state) {
      case State.CONNECTING:
        this._showStatus("Connecting\u2026", { spinner: false });
        break;
      case State.CONNECTED:
        this._flashStatus("Connected.", 1500);
        break;
      case State.ERROR:
        this._showStatus(detail || "Connection error", { color: "#b8964a" });
        break;
      case State.IDLE:
        this._showStatus("");
        break;
    }
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
    if (this._statusTimer) { clearTimeout(this._statusTimer); this._statusTimer = null; }
    if (this._statusOverlay) {
      this._statusOverlay.style.display = "none";
    }
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
      // Fail fast on terminal errors (session gone, server restarted, etc.)
      if (data.error) {
        throw new Error(data.error + (data.message ? ": " + data.message : ""));
      }
      await new Promise(r => setTimeout(r, RELAY_POLL_MS));
    }
    throw new Error("Timed out waiting for SDP answer from relay");
  }

  /** @param {object} msg — parsed JSON from DataChannel */
  _handleDataChannelMessage(msg) {
    const type = msg.cmd || msg.type;
    switch (type) {
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
            this.onSaveResult({ index: msg.index, ok: msg.ok, error: msg.error });
          } catch { /* safety */ }
        }
        break;
      case "load_result":
        if (this.onLoadResult) {
          try {
            this.onLoadResult({ ok: msg.ok, error: msg.error });
          } catch { /* safety */ }
        }
        break;
      case "list_saves_result":
        if (this.onListSaves) {
          try {
            this.onListSaves({ entries: msg.entries || [], nextIndex: msg.next_index });
          } catch { /* safety */ }
        }
        break;
      case "core_died":
      case "error":
        {
          const reason = msg.reason || msg.message || "Unknown error";
          console.error("[gv-player] Fatal:", reason);
          this._setState(State.ERROR, reason);
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
   * each connected gamepad's state into its port's RetroArch joypad mask.
   *
   * Gamepad[0] merges into the shared `_inputState` on seat 0 along with
   * keyboard input (GAMEPAD_MASK bits only).
   * Gamepad[i] for i>0 sends on its own seat (this._seat + i) directly
   * over the DataChannel, one 3-byte packet per port per change.
   *
   * Button → bit mapping (KEEP IN SYNC with
   * libretro-runner/src/lib.rs — JoypadButton enum):
   *   Up=4, Down=5, Left=6, Right=7, Start=3, Select=2, A=8, B=0
   * @private
   */
  _setupGamepadInput() {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return;

    this._gamepadActive = true;
    this._gamepadStates = [];

    const poll = () => {
      if (!this._gamepadActive) return;

      const gps = navigator.getGamepads();
      if (!gps) {
        this._gamepadRAF = requestAnimationFrame(poll);
        return;
      }

      const m = this._gamepadMapping;

      for (let i = 0; i < gps.length; i++) {
        const gp = gps[i];
        if (!gp) continue;

        // Log first-time gamepad discovery
        if (this._gamepadStates[i] === undefined) {
          console.log("[GPAD] detected gamepad[" + i + "]:", (gp.id || "unknown").slice(0, 60));
        }

        let state = 0;
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

        const prev = this._gamepadStates[i] ?? 0;
        if (state === prev) continue;
        this._gamepadStates[i] = state;

        if (i === 0) {
          // Gamepad 0: merge into shared _inputState, reuse _sendMask
          this._inputState = (this._inputState & ~GAMEPAD_MASK) | state;
          this._sendMask?.();
        } else {
          // Gamepad i>0: send on its own seat directly
          if (this._dc && this._dc.readyState === "open") {
            try {
              const seat = this._seat + i;
              this._dc.send(new Uint8Array([seat, state & 0xFF, state >> 8]).buffer);
              console.log("[GPAD] gamepad[" + i + "] → seat", seat, "state=" + state.toString(16));
            } catch (e) {
              console.warn("[INPUT] gamepad[" + i + "] send failed:", e?.message || e);
              if (this._dc) this._dc.close();
            }
          }
        }
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
    this._gamepadStates = [];
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
// ── gv-player app — production player glue ───────────────────────────
//
// Imports GvPlayer and wires it to the production player page.
// Handles game start, save/load state commands, reconnect logic.
//
// Loaded from the Next.js player page via <script type="module">.
// Exposes window.gvPlay with startPlayer(), saveState(), loadState().

import { GvPlayer, State } from "./index.js";

// ── UUID polyfill ────────────────────────────────────────────────────
// crypto.randomUUID() is secure-context-only (HTTPS / localhost).
// On plain HTTP we fall back to crypto.getRandomValues → Math.random.

function isPrivateIP(host) {
  // .local mDNS names are always LAN
  if (host.endsWith(".local")) return true;
  // Check if an IP address is in a private/LAN range.
  // Returns false for hostnames (not IPs), true for private IPs.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const b1 = parseInt(ipv4[1], 10), b2 = parseInt(ipv4[2], 10);
  return (
    b1 === 10 ||                                    // 10.0.0.0/8
    b1 === 127 ||                                   // 127.0.0.0/8 loopback
    (b1 === 172 && b2 >= 16 && b2 <= 31) ||         // 172.16.0.0/12
    (b1 === 192 && b2 === 168)                      // 192.168.0.0/16
  );
}

function randomUUID() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 UUID via crypto.getRandomValues (works without HTTPS)
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
    buf[8] = (buf[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join(""),
    ].join("-");
  }
  // Last resort (not cryptographically random, but works anywhere)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}


function csrfHeaders() {
  let token = document.cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("gv_csrf_token="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!token) {
    token = randomUUID();
    document.cookie = `gv_csrf_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  }
  return { "Content-Type": "application/json", "x-csrf-token": decodeURIComponent(token) };
}

function guestClientId() {
  const key = "gv_guest_client_id";
  try {
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return randomUUID();
  }
}

// ── Constants ───────────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const GAME_START_POLL_MS = 100;
const GAME_START_TIMEOUT_MS = 60_000;

// ── startGame helper ────────────────────────────────────────────────

/**
 * Start a game via the signaling relay, wait for the worker to be ready.
 *
 * 1. POSTs start_game to /api/server/command
 * 2. Polls /api/server/notify for worker_url
 * 3. Returns when worker is ready
 *
 * @param {string} serverId
 * @param {string} gameId
 * @param {string} [corePath] — unused (core resolved server-side), kept for compat
 * @param {object} [callbacks] — { onProgress(msg) }
 * @returns {Promise<{workerToken: string, workerUrl: string}>}
 */
async function startGame(serverId, gameId, corePath, hostToken, callbacks, sdpOffer) {
  callbacks?.onProgress?.("Starting game…");

  const payload = {
    game_id: gameId,
    host_token: hostToken,
  };
  if (sdpOffer) {
    payload.sdp = sdpOffer;
  }

  const cmdResp = await fetch("/api/server/command", {
    method: "POST",
    headers: csrfHeaders(),
    body: JSON.stringify({
      server_id: serverId,
      type: "start_game",
      payload,
    }),
  });

  if (!cmdResp.ok) {
    const errData = await cmdResp.json().catch(() => ({}));
    // Long-poll timeout returns sdp-related error in body
    if (errData.error) throw new Error(errData.error);
    throw new Error(
      `start_game failed: HTTP ${cmdResp.status} — ${errData.error || "unknown"}`,
    );
  }

  const cmdData = await cmdResp.json();

  // If we included an SDP offer, gv-web long-polls and returns the answer
  // directly in the POST response — no separate polling needed.
  if (cmdData.sdp_answer) {
    return { workerToken: cmdData.worker_token, workerUrl: null, sdpAnswer: cmdData.sdp_answer };
  }
  if (cmdData.error) {
    throw new Error(cmdData.error);
  }

  const workerToken = cmdData.worker_token;
  if (!workerToken) {
    throw new Error("start_game response missing worker_token");
  }

  callbacks?.onProgress?.("Starting game…");
  callbacks?.onProgress?.(sdpOffer ? "SDP exchanging…" : "Worker starting…");

  // Poll for result (worker_url and optionally sdp_answer)
  const start = Date.now();
  while (Date.now() - start < GAME_START_TIMEOUT_MS) {
    const resp = await fetch(
      `/api/server/notify?server_id=${encodeURIComponent(serverId)}&worker_token=${encodeURIComponent(workerToken)}`,
    );
    if (!resp.ok) {
      throw new Error(`Notify poll failed: HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (data.worker_url) {
      return { workerToken, workerUrl: data.worker_url, sdpAnswer: data.sdp_answer || null };
    }
    // Fail fast on terminal errors (session gone, server restarted, etc.)
    if (data.error) {
      throw new Error(data.error + (data.message ? ": " + data.message : ""));
    }
    await new Promise((r) => setTimeout(r, GAME_START_POLL_MS));
  }
  throw new Error("Timed out waiting for worker to start");
}

// ── startPlayer ─────────────────────────────────────────────────────

/**
 * Start a game, create a GvPlayer, connect via relay, and wire callbacks.
 *
 * @param {HTMLVideoElement} video
 * @param {string} serverId
 * @param {string} gameId
 * @param {string} corePath — path to libretro core for start_game
 * @param {object} callbacks
 * @returns {GvPlayer}
 */
async function fetchIceConfig() {
  try {
    const r = await fetch("/api/ice-config");
    if (r.ok) return await r.json();
    console.warn("[gv] /api/ice-config returned HTTP", r.status);
  } catch (e) {
    console.warn("[gv] /api/ice-config unreachable:", e?.message || e);
  }
  // Fallback: Google STUN only. TURN will not be available.
  // Configure GV_ICE_* env vars on gv-web for TURN support.
  console.warn("[gv] ICE: using Google STUN fallback — no TURN, NAT may fail");
  return { iceServers: [{ urls: "stun:stun.l.google.com:19302" }], iceTransportPolicy: "all" };
}

function startPlayer(video, serverId, gameId, corePath, callbacks, joinToken, hostTokenParam) {
  console.log("[gv] startPlayer called", { serverId, gameId, joinToken: !!joinToken, hostTokenParam: !!hostTokenParam });

  // Fetch ICE config first, then create player with it
  let player = null;
  let iceConfigPromise = fetchIceConfig();
  player = new GvPlayer(video);  // temp, gets iceServers patched async
  console.log("[gv] GvPlayer created, calling doConnect");
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let startGameToken = null;
  let gameStarted = false;
  let sdpAnswer = null;

  // Generate a host token once — reused across reconnects so the
  // worker recognizes the same host after a disconnect.
  const hostToken = (() => {
    // ── Priority: explicit param (from short code) > URL param > new UUID ──
    if (hostTokenParam) {
      console.log("[gv] using hostToken from props:", hostTokenParam.slice(0, 8) + "...");
      return hostTokenParam;
    }
    const urlParams = new URLSearchParams(window.location.search);
    const fromUrl = urlParams.get("host_token");
    if (fromUrl) {
      console.log("[gv] reusing host_token from URL:", fromUrl.slice(0, 8) + "...");
      return fromUrl;
    }
    return randomUUID();
  })();

  // If URL has host_token, this is a page-refresh reconnection.
  // Skip start_game — the server session is still alive.
  // Falls back to start_game if the session is gone (e.g. server restarted).
  let isReconnect = !!new URLSearchParams(window.location.search).get("host_token") || !!hostTokenParam;

  const doConnect = async () => {
    callbacks.onStateChange?.("connecting");
    callbacks?.onProgress?.("handshaking");

    // Wait for ICE config, then apply to player
    const iceConfig = await iceConfigPromise;
    if (iceConfig && iceConfig.iceServers) {
      console.log("[gv] applying ICE config:", iceConfig.iceServers.length, "servers, policy:", iceConfig.iceTransportPolicy);
      player._iceServers = iceConfig.iceServers;
      if (iceConfig.iceTransportPolicy) {
        player._iceTransportPolicy = iceConfig.iceTransportPolicy;
      }
      // Guest links: webrtc-rs 0.17.1 has a bug where relay↔relay candidate
      // pairs fail to form (pingAllCandidates called with no candidate pairs).
      // Forcing relay-only breaks guest connections completely.
      // Let ICE use all candidate types; the srflx path will handle LAN guests.
      // (mDNS host candidates in Firefox private windows are a separate issue —
      //  they are resolvable only locally, not by the Rust ICE stack.)
      console.log("[gv] ICE config loaded:", iceConfig.iceServers.length, "server(s)");
    }

    try {
      if ((joinToken || player._roomToken) && !gameStarted) {
        // Guest join — use rotated room_token from SDP poll if available
        const rt = player._roomToken || joinToken;
        console.log("[gv] guest join — resolving room_token:", rt);
        callbacks?.onProgress?.("Joining room…");
        const joinResp = await fetch("/api/room/join", {
          method: "POST",
          headers: csrfHeaders(),
          body: JSON.stringify({ room_token: rt, client_id: guestClientId() }),
        });
        if (!joinResp.ok) {
          const errData = await joinResp.json().catch(() => ({}));
          throw new Error(`room join failed: HTTP ${joinResp.status} — ${errData.error || "unknown"}`);
        }
        const joinData = await joinResp.json();
        console.log("[gv] room/join response:", joinData);
        player._peerToken = joinData.peer_token;
        player._seat = joinData.seat;
        player._role = joinData.role;
        startGameToken = joinData.worker_token;

        // LAN redirect disabled — guests stay on the gateway origin and use configured ICE/TURN.
        // if (joinData.worker_url) {
        //   ...redirect logic removed...
        // }
      } else if (!gameStarted) {
        // ── URL persistence: create short code on first connect ──
        const persistUrl = async () => {
          try {
            const resp = await fetch("/api/room/shorten", {
              method: "POST",
              headers: csrfHeaders(),
              body: JSON.stringify({
                game_id: gameId,
                host_token: hostToken,
                server_id: serverId,
              }),
            });
            if (resp.ok) {
              const data = await resp.json();
              const shortUrl = `/p/${data.code}`;
              window.history.replaceState(null, "", shortUrl);
              console.log("[gv] short URL persisted:", shortUrl);
            } else {
              console.warn("[gv] shorten API failed, falling back to query params");
              const url = new URL(window.location.href);
              url.searchParams.set("game", gameId);
              url.searchParams.set("host_token", hostToken);
              url.searchParams.set("server_id", serverId);
              window.history.replaceState(null, "", url.toString());
            }
          } catch (e) {
            console.warn("[gv] URL persist failed:", e?.message || e);
          }
        };

        if (isReconnect) {
          // Page-refresh reconnection: skip start_game, go straight to
          // connectViaRelay with a fresh SDP offer.
          // Server detects !host_connected and swaps in a fresh PC.
          console.log("[gv] reconnection mode — skipping start_game");
          gameStarted = true;
          persistUrl();
        } else {
          // Host: generate SDP offer first, then include it in start_game.
          // The server does SDP exchange inline, and the poll returns the answer.
          console.log("[gv] generating SDP offer for start_game...");
          player._createPeerConnection();
          const offer = await player._pc.createOffer();
          await player._pc.setLocalDescription(offer);
          const gatherStart = Date.now();
          await player._waitForIceGatheringComplete();
          console.log("[gv] ICE gather done in", Date.now() - gatherStart, "ms");
          const sdpOffer = player._pc.localDescription?.sdp || offer.sdp;

          console.log("[gv] calling startGame with SDP offer...");
          const sgResult = await startGame(serverId, gameId, corePath, hostToken, callbacks, sdpOffer);
          startGameToken = sgResult.workerToken;
          sdpAnswer = sgResult.sdpAnswer;
          gameStarted = true;
          persistUrl();
          console.log("[gv] startGame complete, sdpAnswer:", !!sdpAnswer);
        }
      } else {
        console.log("[gv] reconnect — reusing existing game session");
      }
    } catch (err) {
      console.error("[gv] startGame/join error:", err?.message || err);
      const msg = err?.message || String(err);
      player._showStatus(msg, { color: "#b8964a" });
      callbacks.onError?.(msg);
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        doReconnect();
      }
      return;
    }

    // Now connect via relay
    try {
      console.log("[gv] calling connectViaRelay...");
      console.log("[gv] player type:", typeof player, "constructor:", player?.constructor?.name);
      console.log("[gv] proto methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(player)));
      console.log("[gv] has connectViaRelay:", typeof player.connectViaRelay);
      await player.connectViaRelay(serverId, gameId, hostToken, startGameToken, player._roomToken || joinToken || undefined, player._peerToken, sdpAnswer);
      console.log("[gv] connectViaRelay returned");
    } catch (err) {
      console.error("[gv] connectViaRelay error:", err?.message || err, err?.stack);
      const msg = err?.message || String(err);
      player._showStatus(msg, { color: "#b8964a" });
      // If this was a reconnection attempt and it failed (session gone),
      // fall back to start_game on the next retry.
      if (isReconnect) {
        console.log("[gv] reconnection failed — falling back to start_game");
        isReconnect = false;
        gameStarted = false;
        sdpAnswer = null;
        startGameToken = null;
      }
      callbacks.onError?.(msg);
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        doReconnect();
      }
    }
  };

  const doReconnect = () => {
    reconnectAttempts++;
    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
      player._showStatus("Reconnect attempt " + reconnectAttempts + "/" + MAX_RECONNECT_ATTEMPTS + "\u2026");
      callbacks.onReconnecting?.(reconnectAttempts);
      reconnectTimer = setTimeout(() => {
        player.disconnect();
        doConnect();
      }, RECONNECT_DELAY_MS);
    } else {
      player._showStatus("Connection lost\ntry again", { color: "#b8964a" });
      callbacks.onReconnectFailed?.();
    }
  };

  player.onStateChange = (state, detail) => {
    callbacks.onStateChange?.(state, detail);
    if (state === State.ERROR && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      doReconnect();
    } else if (state === State.CONNECTED) {
      reconnectAttempts = 0;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      callbacks.onReconnected?.();
    }
  };

  player.onStats = (stats) => {
    callbacks.onStats?.(stats);
  };

  player._onRoute = (route, detail) => {
    console.log("[gv] route detected:", route, detail);
    callbacks.onRoute?.(route, detail);
  };

  player.onSaveResult = ({ index, ok, error }) => {
    callbacks.onSaveResult?.(index, ok, error);
  };

  player.onLoadResult = ({ ok, error }) => {
    callbacks.onLoadResult?.(ok, error);
  };

  player.onListSaves = ({ entries, nextIndex }) => {
    callbacks.onListSaves?.(entries, nextIndex);
  };

  // Start the connection flow
  doConnect();

  return player;
}

// ── sendCommand helpers ─────────────────────────────────────────────

/**
 * Send a JSON command over the player's DataChannel.
 */
function sendCommand(player, cmd) {
  if (!player._dc || player._dc.readyState !== "open") return false;
  try {
    player._dc.send(JSON.stringify(cmd));
    return true;
  } catch (e) {
    console.warn("[gv] sendCommand failed:", e?.message || e);
    return false;
  }
}

function saveState(player) {
  return sendCommand(player, { cmd: "save_state" });
}

function loadState(player) {
  return sendCommand(player, { cmd: "load_state" });
}

function loadStateAt(player, index) {
  return sendCommand(player, { cmd: "load_state", index });
}

function listSaves(player) {
  return sendCommand(player, { cmd: "list_saves" });
}

// ── Expose on window ───────────────────────────────────────────────

window.gvPlay = { startPlayer, saveState, loadState, loadStateAt, listSaves };
