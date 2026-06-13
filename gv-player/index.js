// gv-player — WebRTC client for gv-worker.
//
// Connects to a gv-worker process, negotiates a WebRTC peer connection,
// and renders the received VP8 video track to a <video> element.
//
// Usage:
//   const player = new GvPlayer(videoElement);
//   player.onStateChange = (state) => console.log(state);
//   await player.connect("http://192.168.86.126:3010");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Connection states emitted via onStateChange. */
export const State = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  NEGOTIATING: "negotiating",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  ERROR: "error",
});

export class GvPlayer {
  /**
   * @param {HTMLVideoElement} video — target <video> element (will have
   *   autoplay, playsinline, and muted set automatically)
   */
  constructor(video) {
    // Accept any object that quacks like a video element — DOM polyfills
    // in test environments may not expose HTMLVideoElement as a constructor.
    if (!video || typeof video !== "object" || video.nodeName !== "VIDEO") {
      throw new TypeError("GvPlayer requires a <video> element");
    }

    /** @type {HTMLVideoElement} */
    this.video = video;
    video.autoplay = true;
    video.playsinline = true;
    video.muted = true;

    /** @type {RTCPeerConnection|null} */
    this._pc = null;

    /** @type {State[keyof State]} */
    this._state = State.IDLE;

    /** @type {string} */
    this._workerUrl = "";

    /** @type {(state: string, detail?: string) => void} */
    this.onStateChange = () => {};

    /** @type {(track: MediaStreamTrack) => void} */
    this.onTrack = () => {};
  }

  // ---- Public methods ----

  /**
   * Connect to a gv-worker and begin the WebRTC handshake.
   *
   * @param {string} workerUrl — base URL of the gv-worker (e.g. "http://192.168.86.126:3010")
   * @param {object} [options]
   * @param {RTCConfiguration} [options.rtcConfig] — custom RTCPeerConnection config
   * @returns {Promise<void>}
   */
  async connect(workerUrl, options = {}) {
    if (this._pc) {
      this.disconnect();
    }

    this._workerUrl = workerUrl;
    this._setState(State.CONNECTING);

    try {
      const pc = new RTCPeerConnection(
        options.rtcConfig || {
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        },
      );

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
          this._setState(State.DISCONNECTED, pc.iceConnectionState);
        }
      };

      pc.onconnectionstatechange = () => {
        switch (pc.connectionState) {
          case "connected":
            this._setState(State.CONNECTED);
            break;
          case "disconnected":
          case "failed":
          case "closed":
            this._setState(State.DISCONNECTED, pc.connectionState);
            break;
        }
      };

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream) {
          this.video.srcObject = stream;
        } else {
          // Some browsers don't populate streams[0] on ontrack.
          this.video.srcObject = new MediaStream([event.track]);
        }
        this.onTrack(event.track);
      };

      // Add a recvonly video transceiver — we only receive, never send.
      pc.addTransceiver("video", { direction: "recvonly" });

      this._pc = pc;
      this._setState(State.NEGOTIATING);

      // Create and send SDP offer to the worker.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const response = await fetch(`${workerUrl}/sdp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: offer.sdp }),
      });

      if (!response.ok) {
        throw new Error(`Worker returned ${response.status}`);
      }

      const answer = await response.json();
      if (!answer.sdp) {
        throw new Error("Worker returned empty SDP answer");
      }
      if (typeof answer.sdp === "string" && answer.sdp.startsWith("ERROR")) {
        throw new Error(answer.sdp);
      }

      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: answer.sdp }),
      );
    } catch (err) {
      this._setState(State.ERROR, err.message);
      this.disconnect();
      throw err;
    }
  }

  /**
   * Close the peer connection and reset to idle.
   */
  disconnect() {
    if (this._pc) {
      this._pc.close();
      this._pc = null;
    }
    this.video.srcObject = null;
    if (this._state !== State.ERROR) {
      this._setState(State.IDLE);
    }
  }

  /** Current connection state. */
  get state() {
    return this._state;
  }

  // ---- Internal ----

  /** @param {string} state */
  /** @param {string} [detail] */
  _setState(state, detail) {
    if (this._state === state) return;
    this._state = state;
    try {
      this.onStateChange(state, detail);
    } catch (_) {
      // User callback must not break the player.
    }
  }
}
