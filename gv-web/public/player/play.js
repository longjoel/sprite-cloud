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
const GAME_START_POLL_MS = 500;
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
async function startGame(serverId, gameId, corePath, hostToken, callbacks) {
  callbacks?.onProgress?.("Starting game…");

  const payload = {
    game_id: gameId,
    host_token: hostToken,
  };

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
    throw new Error(
      `start_game failed: HTTP ${cmdResp.status} — ${errData.error || "unknown"}`,
    );
  }

  const cmdData = await cmdResp.json();
  const workerToken = cmdData.worker_token;
  if (!workerToken) {
    throw new Error("start_game response missing worker_token");
  }

  callbacks?.onProgress?.("Starting game…");
  callbacks?.onProgress?.("Worker starting…");

  // Poll for worker URL
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
      return { workerToken, workerUrl: data.worker_url };
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

function startPlayer(video, serverId, gameId, corePath, callbacks, joinToken) {
  console.log("[gv] startPlayer called", { serverId, gameId, joinToken: !!joinToken });

  // Fetch ICE config first, then create player with it
  let player = null;
  let iceConfigPromise = fetchIceConfig();
  player = new GvPlayer(video);  // temp, gets iceServers patched async
  console.log("[gv] GvPlayer created, calling doConnect");
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let startGameToken = null;
  let gameStarted = false;

  // Generate a host token once — reused across reconnects so the
  // worker recognizes the same host after a disconnect.
  const hostToken = randomUUID();

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

        // LAN guest: redirect to worker's HTTP player page.
        // Chrome on HTTP doesn't use mDNS → real IP host candidates →
        // prflx discovery → direct host↔host WebRTC. No TURN needed.
        // Redirect (not iframe) avoids CSP frame-src restrictions.
        if (joinData.worker_url) {
          try {
            const workerHost = new URL(joinData.worker_url).hostname;
            if (isPrivateIP(workerHost)) {
              const redirectUrl = joinData.worker_url
                + "/player?join=" + encodeURIComponent(rt)
                + "&peer_token=" + encodeURIComponent(joinData.peer_token)
                + "&worker_token=" + encodeURIComponent(joinData.worker_token || "")
                + "&server_id=" + encodeURIComponent(joinData.server_id || "")
                + "&seat=" + (joinData.seat ?? 0)
                + "&role=" + encodeURIComponent(joinData.role || "player");
              console.log("[gv] LAN worker detected (" + workerHost + "): redirecting to HTTP player →", redirectUrl);
              window.location.href = redirectUrl;
              return;
            }
          } catch (e) {
            console.warn("[gv] LAN redirect setup failed:", e?.message || e);
          }
        }
      } else if (!gameStarted) {
        // Auto-start the game once. Reconnects should renegotiate against
        // the existing worker/session instead of recursively spawning a
        // fresh worker and resetting the reconnect counter.
        console.log("[gv] calling startGame...");
        const sgResult = await startGame(serverId, gameId, corePath, hostToken, callbacks);
        startGameToken = sgResult.workerToken;
        gameStarted = true;
        console.log("[gv] startGame complete");
      } else {
        console.log("[gv] reconnect — reusing existing game session");
      }
    } catch (err) {
      console.error("[gv] startGame/join error:", err?.message || err);
      callbacks.onError?.(err.message || String(err));
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
      await player.connectViaRelay(serverId, gameId, hostToken, startGameToken, player._roomToken || joinToken || undefined, player._peerToken);
      console.log("[gv] connectViaRelay returned");
    } catch (err) {
      console.error("[gv] connectViaRelay error:", err?.message || err, err?.stack);
      callbacks.onError?.(err.message || String(err));
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        doReconnect();
      }
    }
  };

  const doReconnect = () => {
    reconnectAttempts++;
    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
      callbacks.onReconnecting?.(reconnectAttempts);
      reconnectTimer = setTimeout(() => {
        player.disconnect();
        doConnect();
      }, RECONNECT_DELAY_MS);
    } else {
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

  player.onSaveResult = ({ slot, ok }) => {
    callbacks.onSaveResult?.(slot, ok);
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

function saveState(player, slot) {
  return sendCommand(player, { cmd: "save_state", slot });
}

function loadState(player, slot) {
  return sendCommand(player, { cmd: "load_state", slot });
}

// ── Expose on window ───────────────────────────────────────────────

window.gvPlay = { startPlayer, saveState, loadState };
