// ── gv-player app — production player glue ───────────────────────────
//
// Imports GvPlayer and wires it to the production player page.
// Handles game start, save/load state commands, reconnect logic.
//
// Loaded from the Next.js player page via <script type="module">.
// Exposes window.gvPlay with startPlayer(), saveState(), loadState().

import { GvPlayer, State } from "./gv-player.js";

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

  // ── Touch controls (all devices — also works with mouse on desktop) ──
  var _touchGamepad = null;
  try {
    if (window.TouchGamepad) {
      // Read preset + layout from video dataset (set by GamePlayer React component)
      var preset = video.dataset.gvPreset || 'nes';
      var layout = video.dataset.gvLayout || 'auto';
      _touchGamepad = new window.TouchGamepad(video, { preset: preset, layout: layout });
      _touchGamepad.onInput = function (buttons, axes) {
        console.log('[GPAD] onInput called, _sendInput exists:', typeof player._sendInput, 'dc open:', player._dc && player._dc.readyState);
        if (player && player._sendInput) {
          player._sendInput({ index: 0, buttons: buttons, axes: axes });
          console.log('[GPAD] → _sendInput dispatched');
        }
      };
      // Only auto-show on touch devices; desktop users toggle via 🎮 button
      var shouldShow = (typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0));
      try { shouldShow = shouldShow || localStorage.getItem('gv:touch-visible') === '1'; } catch (_) {}
      if (shouldShow) _touchGamepad.show();
      // Expose globally so GamePlayer.tsx toggle button can control it
      window.__gvTouchGamepad = _touchGamepad;
      console.log("[gv] touch gamepad v2 initialized — preset:", preset, "layout:", layout);
    }
  } catch (e) {
    console.warn("[gv] touch gamepad init failed:", e?.message || e);
  }
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
  const wasReconnect = isReconnect; // snapshot: true if this page load came from a short code
  let connecting = false; // guard against concurrent doConnect() calls

  const doConnect = async () => {
    if (connecting) { console.log("[gv] doConnect already in progress — skipping"); return; }
    connecting = true;
    try {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
          // Page-refresh reconnection: the old session is almost certainly
          // gone (DC close → cancel within milliseconds). Creating a PC,
          // posting sdp_offer, and polling just wastes 5+ seconds and leaks
          // _roomToken into retry paths. Skip it — start_game creates a
          // fresh session with the same game_id, so the short code still
          // resolves correctly.  persistUrl is skipped via wasReconnect.
          console.log("[gv] page refresh detected — skipping reconnect, starting fresh game");
          isReconnect = false;
          // Fall through to start_game below (use `if`, not `else if`)
        }
        if (!gameStarted) {
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
          if (!wasReconnect) { persistUrl(); }
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
    } finally { connecting = false; }
  };

  const doReconnect = () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
