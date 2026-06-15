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
 * @param {string} corePath — path to libretro core
 * @param {object} [callbacks] — { onProgress(msg) }
 * @returns {Promise<{workerToken: string, workerUrl: string}>}
 */
async function startGame(serverId, gameId, corePath, hostToken, callbacks) {
  callbacks?.onProgress?.("Starting game…");

  const cmdResp = await fetch("/api/server/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      server_id: serverId,
      type: "start_game",
      payload: {
        game_id: gameId,
        core_path: corePath,
        host_token: hostToken,
      },
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

  callbacks?.onProgress?.("Waiting for worker…");

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
function startPlayer(video, serverId, gameId, corePath, callbacks) {
  let player = new GvPlayer(video);
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  // Generate a host token once — reused across reconnects so the
  // worker recognizes the same host after a disconnect.
  const hostToken = randomUUID();

  const doConnect = async () => {
    callbacks.onStateChange?.("connecting");

    try {
      // Auto-start the game first
      await startGame(serverId, gameId, corePath, hostToken, callbacks);
    } catch (err) {
      callbacks.onError?.(err.message || String(err));
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        doReconnect();
      }
      return;
    }

    // Now connect via relay
    try {
      await player.connectViaRelay(serverId, gameId, hostToken);
    } catch (err) {
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
        player = startPlayer(video, serverId, gameId, corePath, callbacks);
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
  } catch {
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
