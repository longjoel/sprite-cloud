// gv-player — Web client for playing games via gv-server
// Connects to gv-web SSE for signaling, establishes WebRTC P2P with gv-worker.

export class GameVaultPlayer {
  /**
   * @param {string} sessionId — unique session identifier from gv-web
   * @param {HTMLVideoElement} videoElement — <video> element to render into
   */
  constructor(sessionId, videoElement) {
    this.sessionId = sessionId;
    this.video = videoElement;
    this.eventSource = null;
  }

  connect() {
    const es = new EventSource(`/api/sse/${this.sessionId}`);
    es.addEventListener("sdp", (e) => {
      const { sdp } = JSON.parse(e.data);
      // TODO: apply SDP answer to RTCPeerConnection
      console.log("received SDP:", sdp.substring(0, 30));
    });
    es.addEventListener("error", () => {
      console.log("SSE disconnected, reconnecting...");
    });
    this.eventSource = es;
  }

  disconnect() {
    this.eventSource?.close();
    this.eventSource = null;
  }
}
