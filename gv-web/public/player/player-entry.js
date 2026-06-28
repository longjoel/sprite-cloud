// ── player-entry.js — mode detection + connection glue ────────────
import { GvPlayer, State, classifyRoute, inspectRoute } from './index.js';

const MODE = location.pathname.startsWith('/player') ? 'direct' : 'relay';
console.log('[gv] mode:', MODE);

const video = document.getElementById('video');
const statusEl = document.getElementById('status');
const routeEl = document.getElementById('route-indicator');
const connectingOverlay = document.getElementById('connecting-overlay');
const connectingDetail = document.getElementById('connecting-detail');

// ── Touch controls ──────────────────────────────────────────────────

let _touchGamepad = null;

function initTouchControls() {
  if (_touchGamepad) return;
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!hasTouch) return;

  import('./touch-gamepad.js').then(mod => {
    const TouchGamepad = mod.TouchGamepad || window.TouchGamepad || (mod.default && mod.default.TouchGamepad);
    if (!TouchGamepad) { console.warn('[gv] TouchGamepad not found in module'); return; }
    _touchGamepad = new TouchGamepad(video, { layout: 'auto' });
    _touchGamepad.onInput = (buttons, axes) => {
      const p = _playerRef;
      if (p && p._sendInput) {
        p._sendInput({ index: 0, buttons, axes });
      }
    };
    _touchGamepad.show();
    console.log('[gv] touch gamepad initialized');
  }).catch(e => console.warn('[gv] touch gamepad load failed:', e?.message || e));
}

function setStatus(msg, cls) {
  if (statusEl) { statusEl.textContent = msg; statusEl.className = cls || ''; }
}

function hideConnecting() {
  if (connectingOverlay) {
    connectingOverlay.classList.add('hidden');
  }
}

const DEFAULT_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

async function fetchIceConfig() {
  try {
    const resp = await fetch('/api/ice-config');
    if (resp.ok) {
      const cfg = await resp.json();
      if (Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0) {
        return cfg.iceServers;
      }
    }
    console.warn('[gv] /api/ice-config returned HTTP', resp.status);
  } catch (e) {
    console.warn('[gv] /api/ice-config unreachable:', e?.message || e);
  }
  return DEFAULT_ICE;
}

// ── Direct mode: connect to worker via same-origin SDP ───────────
async function directConnect() {
  const q = new URLSearchParams(location.search);
  const peerToken = q.get('peer_token') || '';
  const role = q.get('role') || 'player';
  const seat = parseInt(q.get('seat') || '0');

  const ICE = await fetchIceConfig();
  const playerOptions = { seat, iceServers: ICE };
  const player = new GvPlayer(video, playerOptions);
  _playerRef = player;
  player._peerToken = peerToken;
  player._seat = seat;
  player._role = role;

  initTouchControls();

  player.onStateChange = (s, d) => {
    if (s === State.CONNECTED) {
      setStatus('connected', 'ok');
      hideConnecting();
    }
    else if (s === State.ERROR) setStatus(d || 'error', 'err');
    else setStatus(s);
  };
  player._onRoute = (route, detail) => {
    console.log('[gv] route:', route, detail);
    if (routeEl) {
      const labels = { local: 'LAN', direct: 'Direct', relay: 'Relay', failed: 'Failed' };
      routeEl.textContent = labels[route] || route;
    }
  };

  setStatus('signaling…');
  try {
    const pc = player._createPeerConnection();
    // _createPeerConnection already creates the DC with auth+input handlers.
    // Chain sendMask on top of the existing onopen (don't overwrite).
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

    setStatus('connecting…');
    const resp = await fetch('/sdp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: pc.localDescription.sdp, peer_token: peerToken, peer_role: role, peer_seat: seat }),
    });
    if (!resp.ok) { setStatus('SDP failed: ' + resp.status, 'err'); return; }
    const answer = await resp.json();
    const clean = answer.sdp.split('\n').filter(l => !l.trimStart().startsWith('a=extmap:')).join('\n');
    await pc.setRemoteDescription({ type: 'answer', sdp: clean });
    console.log('[gv] WebRTC connected via direct SDP');
  } catch (e) {
    setStatus(e.message, 'err');
    console.error(e);
  }
}

// ── Relay mode: connect through gv-web's relay API ───────────────
async function relayConnect() {
  const q = new URLSearchParams(location.search);
  const serverId = q.get('server_id') || '';
  const gameId = location.pathname.split('/').pop();
  const joinToken = q.get('join') || '';

  const ICE = await fetchIceConfig();
  const player = new GvPlayer(video, { iceServers: ICE });
  _playerRef = player;

  initTouchControls();

  player.onStateChange = (s, d) => {
    if (s === State.CONNECTED) {
      setStatus('connected', 'ok');
      hideConnecting();
    }
    else if (s === State.ERROR) setStatus(d || 'error', 'err');
    else setStatus(s);
  };
  player._onRoute = (route, detail) => {
    if (routeEl) {
      const labels = { local: 'LAN', direct: 'Direct', relay: 'Relay', failed: 'Failed' };
      routeEl.textContent = labels[route] || route;
    }
  };

  setStatus('connecting…');
  try {
    if (joinToken) {
      // Guest: resolve room token
      const joinResp = await fetch('/api/room/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_token: joinToken }),
      });
      const joinData = await joinResp.json();
      if (!joinResp.ok) throw new Error(joinData.error || 'Join failed');
      player._peerToken = joinData.peer_token;
      player._seat = joinData.seat;
      player._role = joinData.role;
    }

    setStatus('signaling…');
    const hostToken = joinToken ? null : crypto.randomUUID();
    await player.connectViaRelay(serverId, gameId, hostToken, null, joinToken, player._peerToken);
  } catch (e) {
    setStatus(e.message, 'err');
    console.error(e);
  }
}

// ── Save/load buttons ──────────────────────────────────────────────\nlet _playerRef = null;\nfunction getPlayer() { return _playerRef; }\n\nfunction sendDC(cmd) {\n  const p = getPlayer();\n  if (!p || !p._dc || p._dc.readyState !== \"open\") return false;\n  p._dc.send(JSON.stringify(cmd));\n  return true;\n}\n\nconst saveBtn = document.getElementById('save-btn');\nconst loadBtn = document.getElementById('load-btn');\nif (saveBtn) saveBtn.onclick = () => sendDC({ cmd: \"save_state\" });\nif (loadBtn) loadBtn.onclick = () => sendDC({ cmd: \"load_state\" });\n\n// ── Boot ──────────────────────────────────────────────────────────\n(async () => {\n  if (!video) return;\n  if (MODE === 'direct') await directConnect();\n  else await relayConnect();\n})();
