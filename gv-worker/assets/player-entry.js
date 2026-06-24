// ── player-entry.js — mode detection + connection glue ────────────
import { GvPlayer, State, classifyRoute, inspectRoute } from './index.js';

// Direct-origin: worker serves /sdp directly.
// Proxy-origin: gv-web forwards /sdp through the worker-proxy route.
// Both have /sdp on the current origin, so always use direct mode.
const MODE = location.pathname.startsWith('/player')
  || location.pathname.includes('/api/worker-proxy')
  ? 'direct' : 'relay';
console.log('[gv] mode:', MODE);

const video = document.getElementById('video');
const statusEl = document.getElementById('status');
const routeEl = document.getElementById('route-indicator');
const connectingOverlay = document.getElementById('connecting-overlay');
const connectingDetail = document.getElementById('connecting-detail');

function setStatus(msg, cls) {
  if (statusEl) { statusEl.textContent = msg; statusEl.className = cls || ''; }
}

function hideConnecting() {
  if (connectingOverlay) {
    connectingOverlay.classList.add('hidden');
  }
}

// ICE config
const ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'turn:lngnckr.tech:3478', username: 'gv', credential: '43b908d07b1f25c97553d43d317ee5fb' },
];

// ── Direct mode: connect to worker via same-origin SDP ───────────
async function directConnect() {
  const q = new URLSearchParams(location.search);
  const peerToken = q.get('peer_token') || '';
  const role = q.get('role') || 'player';
  const seat = parseInt(q.get('seat') || '0');

  const playerOptions = { seat, iceServers: ICE };
  const player = new GvPlayer(video, playerOptions);
  player._peerToken = peerToken;
  player._seat = seat;
  player._role = role;

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

  const player = new GvPlayer(video, { iceServers: ICE });
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
    await player.connectViaRelay(serverId, gameId, crypto.randomUUID(), null, joinToken, player._peerToken);
  } catch (e) {
    setStatus(e.message, 'err');
    console.error(e);
  }
}

// ── Boot ──────────────────────────────────────────────────────────
(async () => {
  if (!video) return;
  if (MODE === 'direct') await directConnect();
  else await relayConnect();
})();
