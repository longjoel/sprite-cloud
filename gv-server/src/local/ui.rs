//! Game browser UI — serves a single-page HTML app for the local-play server.
//!
//! Uses the Humidor design tokens (same as gv-web and the embedded player)
//! for visual consistency.

use axum::{response::Html, extract::State};
use std::sync::Arc;
use super::AppState;

/// Serve the game browser HTML page.
pub async fn serve_index(State(_state): State<Arc<AppState>>) -> Html<&'static str> {
    Html(INDEX_HTML)
}

const INDEX_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Games Vault — Local</title>
<style>
  :root {
    --color-mahogany: #1a1410;
    --color-teak: #2d2418;
    --color-walnut: #3d3020;
    --color-bamboo: #4a3a28;
    --color-brass: #b8964a;
    --color-copper: #c4723a;
    --color-cream: #e8dcc8;
    --color-muted: #b8a888;
    --color-cyan: #00e5ff;
    --color-magenta: #ff3d7f;
    --color-lime: #a0ff40;
    --color-success: #4dff88;
    --color-warning: #ffb830;
    --color-error: #ff4d4d;

    --space-2: 4px;
    --space-3: 6px;
    --space-4: 8px;
    --space-5: 12px;
    --space-6: 16px;
    --space-7: 24px;
    --space-8: 32px;

    --radius-sm: 2px;
    --radius-md: 4px;

    --font-size-xs: 10px;
    --font-size-sm: 12px;
    --font-size-base: 13px;
    --font-size-md: 14px;
    --font-size-lg: 18px;

    --font-mono: "Geist Mono", "SF Mono", "Fira Code", monospace;
    --font-sans: "Geist", "SF Pro", system-ui, sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--color-mahogany);
    color: var(--color-cream);
    font-family: var(--font-mono);
    min-height: 100vh;
    overflow-y: auto;
  }

  /* ── Header ──────────────────────────────────────────────── */
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-6) var(--space-7);
    border-bottom: 1px solid var(--color-walnut);
    position: sticky;
    top: 0;
    background: var(--color-mahogany);
    z-index: 10;
  }

  header h1 {
    font-family: var(--font-sans);
    font-size: var(--font-size-lg);
    font-weight: 600;
    color: var(--color-brass);
    letter-spacing: 0.04em;
  }

  header .subtitle {
    font-size: var(--font-size-xs);
    color: var(--color-muted);
  }

  /* ── Warnings banner ─────────────────────────────────────── */
  #warnings {
    display: none;
    padding: var(--space-4) var(--space-7);
    background: rgba(255, 184, 48, 0.1);
    border-bottom: 1px solid var(--color-warning);
    color: var(--color-warning);
    font-size: var(--font-size-xs);
  }

  #warnings.visible { display: block; }

  /* ── Playing indicator ───────────────────────────────────── */
  #playing-bar {
    display: none;
    padding: var(--space-4) var(--space-7);
    background: rgba(0, 229, 255, 0.08);
    border-bottom: 1px solid var(--color-cyan);
    color: var(--color-cyan);
    font-size: var(--font-size-xs);
    cursor: pointer;
  }

  #playing-bar.visible { display: block; }
  #playing-bar:hover { background: rgba(0, 229, 255, 0.14); }

  /* ── Search ──────────────────────────────────────────────── */
  #search-box {
    width: 100%;
    padding: var(--space-5) var(--space-7);
  }

  #search-box input {
    width: 100%;
    padding: var(--space-4) var(--space-5);
    background: var(--color-teak);
    border: 1px solid var(--color-walnut);
    border-radius: var(--radius-md);
    color: var(--color-cream);
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    outline: none;
    transition: border-color 0.2s;
  }

  #search-box input:focus {
    border-color: var(--color-brass);
  }

  #search-box input::placeholder {
    color: var(--color-muted);
  }

  /* ── Grid ────────────────────────────────────────────────── */
  #game-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: var(--space-5);
    padding: var(--space-5) var(--space-7);
  }

  /* ── Card ────────────────────────────────────────────────── */
  .game-card {
    background: var(--color-teak);
    border: 1px solid var(--color-walnut);
    border-radius: var(--radius-md);
    padding: var(--space-6);
    cursor: pointer;
    transition: border-color 0.2s, transform 0.15s;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .game-card:hover {
    border-color: var(--color-brass);
    transform: translateY(-1px);
  }

  .game-card:active {
    transform: translateY(0);
  }

  .game-card.playing {
    border-color: var(--color-cyan);
    background: var(--color-bamboo);
  }

  .game-card .name {
    font-size: var(--font-size-base);
    color: var(--color-cream);
    word-break: break-word;
    font-weight: 500;
  }

  .game-card .dir {
    font-size: var(--font-size-xs);
    color: var(--color-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .game-card .meta {
    display: flex;
    gap: var(--space-3);
    align-items: center;
  }

  .badge {
    display: inline-block;
    padding: 1px var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .badge-platform {
    background: rgba(184, 150, 74, 0.15);
    color: var(--color-brass);
  }

  .badge-unknown {
    background: rgba(184, 168, 136, 0.15);
    color: var(--color-muted);
  }

  .badge-playing {
    background: rgba(0, 229, 255, 0.12);
    color: var(--color-cyan);
  }

  /* ── States ──────────────────────────────────────────────── */
  #loading, #empty, #error {
    display: none;
    justify-content: center;
    align-items: center;
    padding: var(--space-8);
    color: var(--color-muted);
    font-size: var(--font-size-md);
    min-height: 200px;
    text-align: center;
  }

  .state-visible {
    display: flex !important;
  }

  #error {
    color: var(--color-error);
  }

  /* ── Count ───────────────────────────────────────────────── */
  #game-count {
    font-size: var(--font-size-xs);
    color: var(--color-muted);
    padding: 0 var(--space-7);
    margin-bottom: var(--space-3);
  }

  /* ── Footer ──────────────────────────────────────────────── */
  footer {
    text-align: center;
    padding: var(--space-8);
    color: var(--color-muted);
    font-size: var(--font-size-xs);
    border-top: 1px solid var(--color-walnut);
    margin-top: var(--space-7);
  }
</style>
</head>
<body>

<header>
  <div>
    <h1>Games Vault</h1>
    <div class="subtitle">local play · no pairing</div>
  </div>
  <div style="font-size:var(--font-size-xs);color:var(--color-muted)">
    <span id="hostname"></span>
  </div>
</header>

<div id="warnings"></div>
<div id="playing-bar">
  ▶ &nbsp;<span id="playing-name"></span>&nbsp;is running — click to resume
</div>

<div id="search-box">
  <input type="text" id="search" placeholder="Filter games…" autofocus>
</div>

<div id="game-count"></div>

<div id="game-grid"></div>

<div id="loading" class="state-visible">scanning ROMs…</div>
<div id="empty">No games found.<br><small>Add ROM directories to<br><code>config.toml → [rom].roots</code></small></div>
<div id="error">Failed to load games.<br><small>Check the server console for details.</small></div>

<footer>Games Vault · local server</footer>

<script>
  (async () => {
    const grid = document.getElementById('game-grid');
    const loading = document.getElementById('loading');
    const empty = document.getElementById('empty');
    const error = document.getElementById('error');
    const count = document.getElementById('game-count');
    const search = document.getElementById('search');
    const hostname = document.getElementById('hostname');
    const warnings = document.getElementById('warnings');
    const playingBar = document.getElementById('playing-bar');
    const playingName = document.getElementById('playing-name');

    hostname.textContent = location.hostname;

    let games = [];
    let sessions = {}; // game_id → worker_url

    // ── Load ──────────────────────────────────────────────────
    async function load() {
      try {
        const [resp, sessResp] = await Promise.all([
          fetch('/api/games'),
          fetch('/api/sessions'),
        ]);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        games = data.games;

        if (data.warnings && data.warnings.length) {
          warnings.textContent = data.warnings.join(' · ');
          warnings.classList.add('visible');
        }

        if (sessResp.ok) {
          const sessList = await sessResp.json();
          for (const s of sessList) sessions[s.game_id] = s.worker_url;
        }

        loading.classList.remove('state-visible');
        render();
      } catch (e) {
        loading.classList.remove('state-visible');
        error.classList.add('state-visible');
        console.error(e);
      }
    }

    // ── Render ────────────────────────────────────────────────
    function render() {
      const term = search.value.toLowerCase();
      const filtered = games.filter(g =>
        g.name.toLowerCase().includes(term) ||
        g.platform.toLowerCase().includes(term)
      );

      count.textContent = filtered.length + ' game' + (filtered.length !== 1 ? 's' : '');

      // Update playing bar
      const activeSession = Object.entries(sessions)[0];
      if (activeSession) {
        const [gid, wurl] = activeSession;
        // Find the game name
        const g = games.find(x => x.id === gid);
        playingName.textContent = g ? g.name : 'Game';
        playingBar.classList.add('visible');
        playingBar.onclick = () => {
          window.location.href = wurl + '/player';
        };
      } else {
        playingBar.classList.remove('visible');
      }

      if (games.length === 0) {
        empty.classList.add('state-visible');
        return;
      }
      empty.classList.remove('state-visible');

      grid.innerHTML = '';
      for (const g of filtered) {
        const isPlaying = !!sessions[g.id];
        const card = document.createElement('div');
        card.className = 'game-card' + (isPlaying ? ' playing' : '');
        card.innerHTML =
          '<div class="name">' + escapeHtml(g.name) + '</div>' +
          '<div class="dir">' + escapeHtml(g.directory) + '</div>' +
          '<div class="meta">' +
            '<span class="badge ' + (g.platform === 'Unknown' ? 'badge-unknown' : 'badge-platform') + '">' +
              escapeHtml(g.platform) +
            '</span>' +
            (isPlaying ? '<span class="badge badge-playing">playing</span>' : '') +
          '</div>';
        card.addEventListener('click', () => play(g.id, g.name));
        grid.appendChild(card);
      }
    }

    // ── Play ──────────────────────────────────────────────────
    async function play(id, name) {
      count.textContent = 'starting ' + name + '…';
      count.style.color = 'var(--color-brass)';

      try {
        const resp = await fetch('/api/games/' + id + '/play', { method: 'POST' });
        if (!resp.ok) {
          const text = await resp.text();
          count.textContent = text || ('failed to start: ' + resp.status);
          count.style.color = 'var(--color-error)';
          return;
        }
        const data = await resp.json();
        // Build the player URL using the browser's own hostname (#466)
        const url = new URL(data.worker_url);
        url.hostname = location.hostname;
        url.port = url.port; // preserve worker port
        const params = new URLSearchParams({
          peer_token: data.peer_token,
          role: 'host',
          seat: '0',
        });
        window.location.href = url.origin + '/player?' + params.toString();
      } catch (e) {
        count.textContent = 'error: ' + e.message;
        count.style.color = 'var(--color-error)';
      }
    }

    function escapeHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    // ── Search filter ─────────────────────────────────────────
    search.addEventListener('input', render);

    // ── Boot ──────────────────────────────────────────────────
    await load();
  })();
</script>

</body>
</html>"##;
