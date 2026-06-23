// ── Inline player connector ──────────────────────────────────────────
// Direct-SDP WebRTC connection to the worker (same origin).
// Serves LAN guests redirected from gv-web's play.js.
// Uses GvPlayer class from index.js.

import { GvPlayer } from "./index.js";

const q = new URLSearchParams(location.search);
const PEER_TOKEN = q.get("peer_token") || "";
const WORKER_TOKEN = q.get("worker_token") || q.get("host_token") || "";
const ROLE = q.get("role") || "player";
const SEAT = parseInt(q.get("seat") || "0");
const JOIN = q.get("join") || "";
const ROOM = q.get("room") || "";

const video = document.getElementById("video");
const statusEl = document.getElementById("status");
const controlsEl = document.getElementById("controls-hint");

function setStatus(msg, cls) {
  if (statusEl) {
    statusEl.textContent = msg;
    statusEl.className = cls || "";
  }
}

// ICE servers: STUN + TURN
const ICE = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "turn:lngnckr.tech:3478", username: "gv", credential: "43b908d07b1f25c97553d43d317ee5fb" },
];

(async () => {
  if (!video) return;
  try {
    const pc = new RTCPeerConnection({ iceServers: ICE });

    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState;
      if (cs === "connected") setStatus("connected", "ok");
      else if (cs === "disconnected" || cs === "failed") setStatus(cs, "err");
      else setStatus(cs);
    };

    pc.ontrack = (e) => {
      if (!video.srcObject) video.srcObject = new MediaStream();
      video.srcObject.addTrack(e.track);
      video.play().catch(() => {});
    };

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    setStatus("signaling…");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise((r) => {
      if (pc.iceGatheringState === "complete") r();
      else pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") r();
      });
    });

    setStatus("connecting…");
    const sdpResp = await fetch("/sdp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp: pc.localDescription.sdp,
        peer_token: PEER_TOKEN,
        peer_role: ROLE,
        peer_seat: SEAT,
      }),
    });

    if (!sdpResp.ok) {
      setStatus("SDP failed: " + sdpResp.status, "err");
      return;
    }

    const answer = await sdpResp.json();
    const clean = answer.sdp
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("a=extmap:"))
      .join("\n");
    await pc.setRemoteDescription({ type: "answer", sdp: clean });
    console.log("[gv] WebRTC connected via direct SDP");
  } catch (e) {
    setStatus(e.message, "err");
    console.error(e);
  }
})();
