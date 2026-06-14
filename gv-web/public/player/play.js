// ── gv-player app — production player glue ───────────────────────────
//
// Imports GvPlayer and wires it to the production player page.
// Handles save/load state commands, reconnect logic, and RTT polling.
//
// Loaded from the Next.js player page via <script type="module">.
// Exposes window.gvPlay with startPlayer(), saveState(), loadState().

import { GvPlayer, State } from "./index.js";

// ── Constants ───────────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_ATTEMPTS = 5;

// ── startPlayer ─────────────────────────────────────────────────────

/**
 * Create a GvPlayer, connect via relay, and wire callbacks.
 *
 * @param {HTMLVideoElement} video
 * @param {string} serverId
 * @param {string} workerToken
 * @param {string} gameId
 * @param {object} callbacks
 * @returns {GvPlayer}
 */
function startPlayer(video, serverId, workerToken, gameId, callbacks) {
  let player = new GvPlayer(video);
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  const doReconnect = () => {
    reconnectAttempts++;
    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
      callbacks.onReconnecting?.(reconnectAttempts);
      reconnectTimer = setTimeout(() => {
        player.disconnect();
        player = startPlayer(video, serverId, workerToken, gameId, callbacks);
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

  player.connectViaRelay(serverId, workerToken, gameId).catch((err) => {
    callbacks.onError?.(err.message || String(err));
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      doReconnect();
    }
  });

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
