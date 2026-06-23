// index.js
function classifyRoute(pair, connectionState) {
  if (connectionState === "failed") {
    return { route: "failed", detail: "ICE failed" };
  }
  const local = pair && pair.localCandidateType || "";
  const remote = pair && pair.remoteCandidateType || "";
  if (!local && !remote) {
    return { route: "unknown", detail: "no candidate stats" };
  }
  if (local === "relay" || remote === "relay") {
    return { route: "relay", detail: "TURN relay" };
  }
  if (local === "srflx" || remote === "srflx") {
    return { route: "direct", detail: "STUN direct" };
  }
  return { route: "local", detail: "LAN host" };
}
async function inspectRoute(pc) {
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
    if (!selectedPair) {
      for (const r of stats.values()) {
        if (r.type === "candidate-pair" && r.state === "succeeded") {
          selectedPair = r;
          break;
        }
      }
    }
    let localCandidateType = "";
    let remoteCandidateType = "";
    if (selectedPair) {
      const localCand = stats.get(selectedPair.localCandidateId);
      const remoteCand = stats.get(selectedPair.remoteCandidateId);
      localCandidateType = localCand && localCand.candidateType || "";
      remoteCandidateType = remoteCand && remoteCand.candidateType || "";
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
  let token = document.cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith("gv_csrf_token="))?.split("=").slice(1).join("=");
  if (!token) {
    token = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    document.cookie = `gv_csrf_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  }
  return { "Content-Type": "application/json", "x-csrf-token": decodeURIComponent(token) };
}
var SDP_ENDPOINT = "/sdp";
var ICE_TIMEOUT_MS = 15e3;
var ICE_CONNECT_TIMEOUT_MS = 6e4;
var DISCONNECTED_GRACE_MS = 5e3;
var PING_INTERVAL_MS = 2e3;
var MAX_PENDING_PINGS = 20;
var RELAY_POLL_MS = 500;
var RELAY_TIMEOUT_MS = 3e4;
var GAMEPAD_MASK = 1 << 0 | 1 << 2 | 1 << 3 | 1 << 4 | 1 << 5 | 1 << 6 | 1 << 7 | 1 << 8;
var DEFAULT_GAMEPAD_MAPPING = Object.freeze({
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  start: 9,
  select: 8,
  a: 0,
  // cross / bottom face button
  b: 1,
  // circle / right face button
  leftStickX: 0,
  // axis index for horizontal
  leftStickY: 1,
  // axis index for vertical
  axisThreshold: 0.5
});
var State = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  ERROR: "error"
});
var GvPlayer = class {
  /** @param {HTMLVideoElement} video — must be a <video> element
   *  @param {{ iceServers?: Array<{urls: string|string[], username?: string, credential?: string}>, seat?: number, iceTimeout?: number, disconnectedGrace?: number, gamepadMapping?: import('./index.js').GamepadMapping }} [options] */
  constructor(video2, options) {
    if (!video2 || !video2.tagName || video2.tagName !== "VIDEO") {
      throw new TypeError("GvPlayer requires a <video> element");
    }
    this._video = video2;
    this._video.autoplay = true;
    this._video.playsinline = true;
    this._iceServers = options && options.iceServers || [];
    this._iceTransportPolicy = options && options.iceTransportPolicy || "all";
    this._seat = options && typeof options.seat === "number" ? options.seat : 0;
    this._iceTimeout = options && typeof options.iceTimeout === "number" ? options.iceTimeout : ICE_TIMEOUT_MS;
    this._disconnectedGrace = options && typeof options.disconnectedGrace === "number" ? options.disconnectedGrace : DISCONNECTED_GRACE_MS;
    this._gamepadMapping = options && options.gamepadMapping || DEFAULT_GAMEPAD_MAPPING;
    this._nintendoLayout = false;
    this._pc = null;
    this._dc = null;
    this._state = State.IDLE;
    this.onStateChange = null;
    this.onTrack = null;
    this.onStats = null;
    this.onSaveResult = null;
    this._iceTimer = null;
    this._disconnectedTimer = null;
    this._rttTimer = null;
    this._stats = { video: {}, audio: {}, pipeline: {} };
    this._rttMs = null;
    this._pingSeq = 0;
    this._pendingPings = /* @__PURE__ */ new Map();
    this._route = null;
    this._onRoute = null;
    this._gamepadActive = false;
    this._gamepadState = 0;
    this._gamepadRAF = null;
    this._playbackDeferred = false;
    this._gestureHandler = null;
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
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    await this._waitForIceGatheringComplete();
    const sdpUrl = `${url}${SDP_ENDPOINT}`;
    const resp = await fetch(sdpUrl, {
      method: "POST",
      headers: gvCsrfHeaders(),
      body: JSON.stringify({ sdp: this._pc.localDescription?.sdp || offer.sdp })
    });
    if (!resp.ok) {
      throw new Error(`SDP POST returned HTTP ${resp.status}`);
    }
    const answer = await resp.json();
    if (!answer.sdp) {
      throw new Error("SDP answer missing sdp field");
    }
    await this._pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp: answer.sdp })
    );
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
    console.log("[gv] connectViaRelay starting", { serverId, gameId, roomToken: !!roomToken, pollToken: !!pollToken, peerToken: !!peerToken });
    if (this._state !== State.IDLE) {
      this.disconnect();
    }
    this._setState(State.CONNECTING);
    this._hostToken = hostToken || null;
    this._peerToken = peerToken || null;
    this._createPeerConnection();
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    await this._waitForIceGatheringComplete();
    const cmdBody = {
      server_id: serverId,
      type: "sdp_offer",
      payload: { game_id: gameId, sdp: this._pc.localDescription?.sdp || offer.sdp, host_token: hostToken }
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
      body: JSON.stringify(cmdBody)
    });
    if (!cmdResp.ok) {
      const errData = await cmdResp.json().catch(() => ({}));
      throw new Error(
        `sdp_offer POST failed: HTTP ${cmdResp.status} \u2014 ${errData.error || "unknown"}`
      );
    }
    const cmdData = await cmdResp.json();
    const workerToken = cmdData.worker_token;
    if (!workerToken) {
      throw new Error("sdp_offer response missing worker_token");
    }
    let answerSdp = await this._pollForAnswer(serverId, pollToken || workerToken);
    console.log("[gv] SDP answer received, setting remote description");
    answerSdp = answerSdp.split("\n").filter((line) => !line.trimStart().startsWith("a=extmap:")).join("\n");
    const removed = (answerSdp.match(/a=extmap:/g) || []).length;
    console.log("[gv] SDP extmap normalised, extmaps remaining:", removed);
    await this._pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp: answerSdp })
    );
    console.log("[gv] remote description set, waiting for ICE...");
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
    if (this._pc) {
      this._pc.onconnectionstatechange = null;
      this._pc.oniceconnectionstatechange = null;
      this._pc.ontrack = null;
      this._pc.close();
      this._pc = null;
    }
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach((t) => t.stop());
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
      iceTransportPolicy: this._iceTransportPolicy
    });
    this._pc.oniceconnectionstatechange = () => {
    };
    this._pc.onconnectionstatechange = () => {
      const s = this._pc.connectionState;
      console.log("[gv] connectionState \u2192", s);
      if (s === "connected") {
        this._setState(State.CONNECTED);
        this._clearIceTimer();
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
        if (this._disconnectedTimer === null) {
          this._disconnectedTimer = setTimeout(() => {
            if (this._pc && this._pc.connectionState === "disconnected") {
              this._setState(State.ERROR, "disconnected (recovery timeout)");
              this._cleanup();
            }
          }, this._disconnectedGrace);
        }
      } else {
        this._clearDisconnectedTimer();
      }
    };
    this._pc.ontrack = (event) => {
      console.log("[gv] ontrack fired", { kind: event.track?.kind, id: event.track?.id, readyState: event.track?.readyState });
      if (!this._mediaStream) {
        this._mediaStream = new MediaStream();
        this._video.srcObject = this._mediaStream;
        console.log("[gv] MediaStream attached to video");
      }
      this._mediaStream.addTrack(event.track);
      console.log("[gv] track added, stream tracks:", this._mediaStream.getTracks().length);
      this._playbackDeferred = true;
      this._video.play().then(() => {
        this._playbackDeferred = false;
        this._video.muted = false;
        console.log("[gv] audio unmuted");
      }).catch((e) => {
        console.debug("play() deferred \u2014 waiting for user gesture:", e.message || e);
      });
      if (this.onTrack) {
        try {
          this.onTrack(event.track);
        } catch {
        }
      }
    };
    this._pc.addTransceiver("video", { direction: "recvonly" });
    this._pc.addTransceiver("audio", { direction: "recvonly" });
    this._dc = this._pc.createDataChannel("diagnostics");
    this._dc.onmessage = (msgEvent) => {
      try {
        const msg = JSON.parse(msgEvent.data);
        this._handleDataChannelMessage(msg);
      } catch {
        console.debug("DataChannel non-JSON message:", msgEvent.data?.slice?.(0, 80) || msgEvent.data);
      }
    };
    this._dc.onopen = () => {
      const authCmd = { cmd: "auth" };
      if (this._peerToken) authCmd.peer_token = this._peerToken;
      if (this._hostToken && !this._peerToken) authCmd.host_token = this._hostToken;
      if (authCmd.peer_token || authCmd.host_token) {
        try {
          this._dc.send(JSON.stringify(authCmd));
        } catch (e) {
          console.warn("[DC] auth send failed:", e?.message || e, "\u2014 DC closing");
          this._dc.close();
        }
      }
      if (this._sendMask) this._sendMask();
    };
    this._setupKeyboardInput();
    this._setupGamepadInput();
    const deferredPlay = () => {
      if (!this._playbackDeferred) return;
      this._playbackDeferred = false;
      this._video.play().then(() => {
        this._video.muted = false;
      }).catch((e) => {
        console.debug("deferred play() still blocked:", e.message || e);
      });
      if (this._gestureHandler) {
        document.removeEventListener("pointerdown", this._gestureHandler, true);
        document.removeEventListener("touchstart", this._gestureHandler, true);
        document.removeEventListener("keydown", this._gestureHandler, true);
        this._gestureHandler = null;
      }
    };
    this._gestureHandler = deferredPlay;
    document.addEventListener("pointerdown", deferredPlay, true);
    document.addEventListener("touchstart", deferredPlay, true);
    document.addEventListener("keydown", deferredPlay, true);
    this._startPingInterval();
    return this._pc;
  }
  /** @param {string} state */
  _setState(state, detail) {
    if (state === this._state) return;
    this._state = state;
    if (this.onStateChange) {
      try {
        this.onStateChange(state, detail);
      } catch {
      }
    }
  }
  _cleanup() {
    this._clearIceTimer();
    this._clearDisconnectedTimer();
    this._stopPingInterval();
    this._removeKeyboardInput();
    this._removeGamepadInput();
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
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach((t) => t.stop());
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
    const timeout = isRelayOnly ? 6e4 : this._iceTimeout;
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
        if (isRelayOnly) {
          const sdp = this._pc.localDescription?.sdp || "";
          if (!sdp.includes("a=candidate:")) {
            continue;
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
        `/api/server/notify?server_id=${encodeURIComponent(serverId)}&worker_token=${encodeURIComponent(workerToken)}`
      );
      if (!resp.ok) {
        throw new Error(`Notify poll failed: HTTP ${resp.status}`);
      }
      const data = await resp.json();
      if (data.sdp_answer) {
        if (data.room_token) this._roomToken = data.room_token;
        return data.sdp_answer;
      }
      await new Promise((r) => setTimeout(r, RELAY_POLL_MS));
    }
    throw new Error("Timed out waiting for SDP answer from relay");
  }
  /** @param {object} msg — parsed JSON from DataChannel */
  _handleDataChannelMessage(msg) {
    switch (msg.type) {
      case "stats":
        this._stats = msg;
        if (this.onStats) {
          try {
            this.onStats(msg);
          } catch {
          }
        }
        break;
      case "pong":
        {
          const seq = msg.seq;
          if (seq != null && this._pendingPings.has(seq)) {
            const sentAt = this._pendingPings.get(seq);
            this._pendingPings.delete(seq);
            this._rttMs = performance.now() - sentAt;
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
          } catch {
          }
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
            try {
              this.onError(reason);
            } catch {
            }
          }
        }
        break;
    }
  }
  _startPingInterval() {
    this._stopPingInterval();
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
        seq,
        client_ts: clientTs
      }));
    } catch {
      console.warn("DC send(ping) failed \u2014 channel closing");
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
    const DEFAULT_BIT_MAP = Object.freeze({
      // D-pad
      ArrowUp: 4,
      ArrowDown: 5,
      ArrowLeft: 6,
      ArrowRight: 7,
      w: 4,
      a: 6,
      s: 5,
      d: 7,
      // Face buttons (SNES layout: B=bottom, A=right, Y=left, X=top)
      z: 0,
      x: 8,
      // B, A
      c: 9,
      v: 1,
      // X, Y
      // Shoulder
      f: 10,
      g: 11,
      // L, R
      r: 12,
      t: 13,
      // L2, R2
      // Start / Select
      q: 3,
      e: 2,
      Enter: 3,
      " ": 3,
      Shift: 2
      // Select
    });
    let BIT_MAP = { ...DEFAULT_BIT_MAP };
    try {
      const saved = localStorage.getItem("gv-keymap");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === "object") {
          Object.assign(BIT_MAP, parsed);
        }
      }
    } catch (_) {
    }
    this._bitMap = BIT_MAP;
    this._defaultBitMap = DEFAULT_BIT_MAP;
    try {
      const nintendo = localStorage.getItem("gv-nintendo-layout");
      if (nintendo === "1") {
        this._nintendoLayout = true;
        this._applyNintendoLayout();
      }
    } catch (_) {
    }
    this._inputState = 0;
    const sendMask = () => {
      if (!this._dc || this._dc.readyState !== "open") {
        console.debug("[INPUT] sendMask skipped \u2014 dc readyState=%s", this._dc?.readyState ?? "null");
        return;
      }
      try {
        const s = this._inputState;
        const buf = new Uint8Array([this._seat, s & 255, s >> 8]);
        this._dc.send(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        console.debug("[INPUT] sent mask port=%d state=0x%s", this._seat, s.toString(16).padStart(4, "0"));
      } catch (e) {
        console.warn("[INPUT] sendMask failed \u2014 DC may be closed:", e?.message || e);
        if (this._dc) this._dc.close();
      }
    };
    this._sendMask = sendMask;
    const handler = (e) => {
      const bit = BIT_MAP[e.key];
      if (bit === void 0) return;
      e.preventDefault();
      if (e.type === "keydown") {
        this._inputState |= 1 << bit;
      } else {
        this._inputState &= ~(1 << bit);
      }
      console.debug(
        "[INPUT] key=%s type=%s bit=%d state=0x%s dc=%s",
        e.key,
        e.type,
        bit,
        this._inputState.toString(16).padStart(4, "0"),
        this._dc?.readyState ?? "none"
      );
      sendMask();
    };
    this._keyHandler = handler;
    document.addEventListener("keydown", handler);
    document.addEventListener("keyup", handler);
    this._blurHandler = () => {
      this._inputState = 0;
      sendMask();
    };
    window.addEventListener("blur", this._blurHandler);
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
      if (gp.buttons[m.dpadUp]?.pressed || gp.axes[m.leftStickY] < -m.axisThreshold) state |= 1 << 4;
      if (gp.buttons[m.dpadDown]?.pressed || gp.axes[m.leftStickY] > m.axisThreshold) state |= 1 << 5;
      if (gp.buttons[m.dpadLeft]?.pressed || gp.axes[m.leftStickX] < -m.axisThreshold) state |= 1 << 6;
      if (gp.buttons[m.dpadRight]?.pressed || gp.axes[m.leftStickX] > m.axisThreshold) state |= 1 << 7;
      if (gp.buttons[m.start]?.pressed) state |= 1 << 3;
      if (gp.buttons[m.select]?.pressed) state |= 1 << 2;
      if (gp.buttons[m.a]?.pressed) state |= 1 << 8;
      if (gp.buttons[m.b]?.pressed) state |= 1 << 0;
      if (state !== this._gamepadState) {
        this._gamepadState = state;
        this._inputState = this._inputState & ~GAMEPAD_MASK | state;
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
    } catch (_) {
    }
  }
  /** Reset all key mappings to defaults. */
  resetKeymap() {
    this._bitMap = { ...this._defaultBitMap };
    try {
      localStorage.removeItem("gv-keymap");
    } catch (_) {
    }
    return this._bitMap;
  }
  // ── Nintendo layout toggle ────────────────────────────────────
  /** Toggle Nintendo button layout: swap A↔B, X↔Y.
   *  Persists to localStorage under "gv-nintendo-layout".
   *  @returns {boolean} new state (true = Nintendo layout active). */
  toggleNintendoLayout() {
    this._nintendoLayout = !this._nintendoLayout;
    this._applyNintendoLayout();
    try {
      localStorage.setItem("gv-nintendo-layout", this._nintendoLayout ? "1" : "0");
    } catch (_) {
    }
    this._updateControlsHint();
    return this._nintendoLayout;
  }
  /** Apply Nintendo layout to BIT_MAP (called by toggle + setup). */
  _applyNintendoLayout() {
    if (this._nintendoLayout) {
      this._bitMap.z = 8;
      this._bitMap.x = 0;
      this._bitMap.c = 1;
      this._bitMap.v = 9;
    } else {
      this._bitMap.z = 0;
      this._bitMap.x = 8;
      this._bitMap.c = 9;
      this._bitMap.v = 1;
    }
  }
  /** Update the #controls-hint text and #nintendo-toggle button state. */
  _updateControlsHint() {
    const hint = document.getElementById("controls-hint");
    const btn = document.getElementById("nintendo-toggle");
    if (hint) {
      if (this._nintendoLayout) {
        hint.textContent = "Q=Start · W=Select · Arrows=Move · Z=A · X=B";
      } else {
        hint.textContent = "Q=Start · W=Select · Arrows=Move · Z=B · X=A";
      }
    }
    if (btn) {
      btn.textContent = this._nintendoLayout ? "🎮 NIN" : "🎮 SNES";
      btn.classList.toggle("active", this._nintendoLayout);
    }
  }
  // ── Cleanup ──────────────────────────────────────────────────
};
if (typeof window !== "undefined" && typeof document !== "undefined") {
  const params = new URLSearchParams(location.search);
  const workerParam = params.get("worker");
  if (workerParam) {
    const video2 = (
      /** @type {HTMLVideoElement} */
      document.getElementById("video")
    );
    if (video2) {
      const player = new GvPlayer(video2);
      const statusEl2 = document.getElementById("status");
      player.onStateChange = (state, detail) => {
        if (statusEl2) {
          statusEl2.textContent = state + (detail ? `: ${detail}` : "");
          if (state === State.ERROR) statusEl2.classList.add("error");
        }
      };
      player.connect(workerParam).catch((err) => {
        console.error("[gv] auto-connect failed:", err?.message || err, err?.stack);
        if (statusEl2) {
          statusEl2.textContent = `error: ${err.message || err}`;
          statusEl2.classList.add("error");
        }
      });
      window.gvPlayer = player;

      // Nintendo layout toggle button
      const nintendoBtn = document.getElementById("nintendo-toggle");
      if (nintendoBtn) {
        nintendoBtn.addEventListener("click", () => {
          player.toggleNintendoLayout();
        });
        if (player._nintendoLayout) {
          nintendoBtn.textContent = "🎮 NIN";
          nintendoBtn.classList.add("active");
        }
      }
    }
  }
}

// player-entry.js
var MODE = location.pathname.startsWith("/player") ? "direct" : "relay";
console.log("[gv] mode:", MODE);
var video = document.getElementById("video");
var statusEl = document.getElementById("status");
var routeEl = document.getElementById("route-indicator");
var connectingOverlay = document.getElementById("connecting-overlay");
var connectingDetail = document.getElementById("connecting-detail");
function setStatus(msg, cls) {
  if (statusEl) {
    statusEl.textContent = msg;
    statusEl.className = cls || "";
  }
}
function hideConnecting() {
  if (connectingOverlay) {
    connectingOverlay.classList.add("hidden");
  }
}
var ICE = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "turn:lngnckr.tech:3478", username: "gv", credential: "43b908d07b1f25c97553d43d317ee5fb" }
];
async function directConnect() {
  const q = new URLSearchParams(location.search);
  const peerToken = q.get("peer_token") || "";
  const role = q.get("role") || "player";
  const seat = parseInt(q.get("seat") || "0");
  const playerOptions = { seat, iceServers: ICE };
  const player = new GvPlayer(video, playerOptions);
  player._peerToken = peerToken;
  player._seat = seat;
  player._role = role;
  player.onStateChange = (s, d) => {
    if (s === State.CONNECTED) {
      setStatus("connected", "ok");
      hideConnecting();
    } else if (s === State.ERROR) setStatus(d || "error", "err");
    else setStatus(s);
  };
  player._onRoute = (route, detail) => {
    console.log("[gv] route:", route, detail);
    if (routeEl) {
      const labels = { local: "LAN", direct: "Direct", relay: "Relay", failed: "Failed" };
      routeEl.textContent = labels[route] || route;
    }
  };
  // Nintendo layout toggle
  (() => {
    const btn = document.getElementById("nintendo-toggle");
    if (btn) {
      btn.addEventListener("click", () => player.toggleNintendoLayout());
      if (player._nintendoLayout) { btn.textContent = "🎮 NIN"; btn.classList.add("active"); }
    }
  })();
  setStatus("signaling\u2026");
  try {
    const pc = player._createPeerConnection();
    const dc = player._dc;
    const prevOnOpen = dc.onopen;
    dc.onopen = () => {
      if (prevOnOpen) prevOnOpen();
      if (player._sendMask) player._sendMask();
    };
    player._setState(State.CONNECTING);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await player._waitForIceGatheringComplete();
    setStatus("connecting\u2026");
    const resp = await fetch("/sdp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: pc.localDescription.sdp, peer_token: peerToken, peer_role: role, peer_seat: seat })
    });
    if (!resp.ok) {
      setStatus("SDP failed: " + resp.status, "err");
      return;
    }
    const answer = await resp.json();
    const clean = answer.sdp.split("\n").filter((l) => !l.trimStart().startsWith("a=extmap:")).join("\n");
    await pc.setRemoteDescription({ type: "answer", sdp: clean });
    console.log("[gv] WebRTC connected via direct SDP");
  } catch (e) {
    setStatus(e.message, "err");
    console.error(e);
  }
}
async function relayConnect() {
  const q = new URLSearchParams(location.search);
  const serverId = q.get("server_id") || "";
  const gameId = location.pathname.split("/").pop();
  const joinToken = q.get("join") || "";
  const player = new GvPlayer(video, { iceServers: ICE });
  player.onStateChange = (s, d) => {
    if (s === State.CONNECTED) {
      setStatus("connected", "ok");
      hideConnecting();
    } else if (s === State.ERROR) setStatus(d || "error", "err");
    else setStatus(s);
  };
  player._onRoute = (route, detail) => {
    if (routeEl) {
      const labels = { local: "LAN", direct: "Direct", relay: "Relay", failed: "Failed" };
      routeEl.textContent = labels[route] || route;
    }
  };
  // Nintendo layout toggle
  (() => {
    const btn = document.getElementById("nintendo-toggle");
    if (btn) {
      btn.addEventListener("click", () => player.toggleNintendoLayout());
      if (player._nintendoLayout) { btn.textContent = "🎮 NIN"; btn.classList.add("active"); }
    }
  })();
  setStatus("connecting\u2026");
  try {
    if (joinToken) {
      const joinResp = await fetch("/api/room/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room_token: joinToken })
      });
      const joinData = await joinResp.json();
      if (!joinResp.ok) throw new Error(joinData.error || "Join failed");
      player._peerToken = joinData.peer_token;
      player._seat = joinData.seat;
      player._role = joinData.role;
    }
    setStatus("signaling\u2026");
    await player.connectViaRelay(serverId, gameId, crypto.randomUUID(), null, joinToken, player._peerToken);
  } catch (e) {
    setStatus(e.message, "err");
    console.error(e);
  }
}
(async () => {
  if (!video) return;
  if (MODE === "direct") await directConnect();
  else await relayConnect();
})();
