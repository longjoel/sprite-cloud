"use client";

import { useCallback, useEffect, useState } from "react";

// ── Constants (no magic values) ───────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const NUMERIC_UUID_RE = /^[0-9a-f-]{36}$/;

// ── Types ─────────────────────────────────────────────────────────────

interface StatusCard {
  label: string;
  value: string;
  ok: boolean;
}

// ── Page ──────────────────────────────────────────────────────────────

export default function DevDashboard() {
  const [cards, setCards] = useState<StatusCard[]>([]);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [cmdServerId, setCmdServerId] = useState("");
  const [cmdType, setCmdType] = useState("start_game");
  const [cmdPayload, setCmdPayload] = useState('{"game_id":"smw"}');
  const [cmdResult, setCmdResult] = useState("");

  // ── Play game state ──────────────────────────────────────────────

  const [playServerId, setPlayServerId] = useState("");
  const [playGameId, setPlayGameId] = useState("smw");
  const [playStatus, setPlayStatus] = useState("");
  const [workerUrl, setWorkerUrl] = useState<string | null>(null);
  const [workerToken, setWorkerToken] = useState<string | null>(null);

  // ── Health poll ─────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    const results: StatusCard[] = [];

    // gv-web itself
    results.push({ label: "gv-web", value: "up", ok: true });

    // Verify API (tests bearer auth + DB)
    try {
      const r = await fetch("/api/auth/verify");
      results.push({
        label: "DB",
        value: r.ok ? "connected" : `HTTP ${r.status}`,
        ok: r.ok,
      });
    } catch {
      results.push({ label: "DB", value: "unreachable", ok: false });
    }

    // Poll endpoint (how many pending commands?)
    try {
      // This will 401 without a bearer token, but confirms the route exists
      const r = await fetch("/api/server/poll");
      if (r.status === 401) {
        results.push({ label: "poll API", value: "up (needs auth)", ok: true });
      } else {
        const data = await r.json();
        results.push({
          label: "pending commands",
          value: String(data.commands?.length ?? "?"),
          ok: true,
        });
      }
    } catch {
      results.push({ label: "poll API", value: "down", ok: false });
    }

    setCards(results);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // ── Generate pairing code ────────────────────────────────────────

  const generateCode = async () => {
    try {
      const r = await fetch("/api/auth/pair/generate", { method: "POST" });
      if (!r.ok) {
        setPairingCode(`Error: ${r.status} (sign in first)`);
        return;
      }
      const data = await r.json();
      setPairingCode(data.code);
    } catch {
      setPairingCode("Network error");
    }
  };

  // ── Queue command ────────────────────────────────────────────────

  const queueCommand = async () => {
    if (!NUMERIC_UUID_RE.test(cmdServerId)) {
      setCmdResult("Invalid server_id format (must be UUID)");
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(cmdPayload);
    } catch {
      setCmdResult("Invalid JSON payload");
      return;
    }
    try {
      const r = await fetch("/api/server/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server_id: cmdServerId,
          type: cmdType,
          payload,
        }),
      });
      const data = await r.json();
      setCmdResult(`HTTP ${r.status}: ${JSON.stringify(data)}`);
    } catch (e) {
      setCmdResult(`Network error: ${e}`);
    }
  };

  // ── Play game ────────────────────────────────────────────────────

  const playGame = async () => {
    setWorkerUrl(null);
    setWorkerToken(null);
    setPlayStatus("");

    if (!NUMERIC_UUID_RE.test(playServerId)) {
      setPlayStatus("Invalid server_id (must be UUID)");
      return;
    }

    // 1. Queue start_game command
    setPlayStatus("Queueing…");
    let workerToken: string;
    try {
      const r = await fetch("/api/server/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server_id: playServerId,
          type: "start_game",
          payload: { game_id: playGameId },
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        setPlayStatus(`Command failed: HTTP ${r.status} — ${JSON.stringify(data)}`);
        return;
      }
      workerToken = data.worker_token;
      setWorkerToken(workerToken);
    } catch (e) {
      setPlayStatus(`Network error: ${e}`);
      return;
    }

    // 2. Poll for worker URL (must include worker_token)
    const POLL_MS = 500;
    const TIMEOUT_MS = 30_000;
    const start = Date.now();

    setPlayStatus("Waiting for worker…");

    const poll = async () => {
      try {
        const r = await fetch(
          `/api/server/notify?server_id=${encodeURIComponent(playServerId)}&worker_token=${encodeURIComponent(workerToken)}`,
        );
        const data = await r.json();
        if (data.worker_url) {
          setWorkerUrl(data.worker_url);
          setPlayStatus("Ready!");
          return;
        }
      } catch {
        // retry
      }

      if (Date.now() - start > TIMEOUT_MS) {
        setPlayStatus("Timed out waiting for worker");
        return;
      }

      setTimeout(poll, POLL_MS);
    };

    poll();
  };

  // ── Render ───────────────────────────────────────────────────────

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Dev Dashboard</h1>

      {/* Status cards */}
      <div style={styles.row}>
        {cards.map((c) => (
          <div
            key={c.label}
            style={{
              ...styles.card,
              borderColor: c.ok ? "#2a2" : "#a22",
            }}
          >
            <div style={styles.cardLabel}>{c.label}</div>
            <div style={styles.cardValue}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Pairing code */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Pairing Code</h2>
        <button style={styles.btn} onClick={generateCode}>
          Generate
        </button>
        {pairingCode && (
          <code style={styles.code}>{pairingCode}</code>
        )}
      </section>

      {/* Command queue */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Queue Command</h2>
        <div style={styles.formRow}>
          <label style={styles.label}>
            server_id
            <input
              style={styles.input}
              value={cmdServerId}
              onChange={(e) => setCmdServerId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </label>
          <label style={styles.label}>
            type
            <select
              style={{ ...styles.input, width: 160 }}
              value={cmdType}
              onChange={(e) => setCmdType(e.target.value)}
            >
              <option value="start_game">start_game</option>
              <option value="stop_game">stop_game</option>
              <option value="sdp_offer">sdp_offer</option>
            </select>
          </label>
        </div>
        <label style={styles.label}>
          payload (JSON)
          <textarea
            style={{ ...styles.input, height: 60, fontFamily: "monospace" }}
            value={cmdPayload}
            onChange={(e) => setCmdPayload(e.target.value)}
          />
        </label>
        <button style={styles.btn} onClick={queueCommand}>
          Send
        </button>
        {cmdResult && (
          <pre style={styles.pre}>{cmdResult}</pre>
        )}
      </section>

      {/* Links */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Play Game</h2>
        <div style={styles.formRow}>
          <label style={styles.label}>
            server_id
            <input
              style={styles.input}
              value={playServerId}
              onChange={(e) => setPlayServerId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </label>
          <label style={styles.label}>
            game_id
            <input
              style={{ ...styles.input, width: 120 }}
              value={playGameId}
              onChange={(e) => setPlayGameId(e.target.value)}
            />
          </label>
        </div>
        <button style={styles.btn} onClick={playGame}>
          Play
        </button>
        {playStatus && (
          <pre style={styles.pre}>{playStatus}</pre>
        )}
        {workerUrl && (
          <div style={{ marginTop: 8 }}>
            <a
              style={styles.link}
              href={`/player/index.html?worker=${encodeURIComponent(workerUrl)}`}
              target="_blank"
              rel="noreferrer"
            >
              Open Player → {workerUrl}
            </a>
          </div>
        )}
      </section>

      {/* Links */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Links</h2>
        <div style={styles.linkRow}>
          {LINKS.map((l) => (
            <a key={l.href} style={styles.link} href={l.href}>
              {l.label}
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}

// ── Links ──────────────────────────────────────────────────────────────

const LINKS: Array<{ label: string; href: string }> = [
  { label: "Games Vault (v1)", href: "http://localhost:8090" },
  { label: "Jellyfin", href: "http://localhost:8096" },
  { label: "Home Assistant", href: "http://localhost:8123" },
  { label: "gv-test VPS", href: "https://gv-test.lngnckr.tech" },
  { label: "Production", href: "https://lngnckr.tech" },
];

// ── Styles (inline, no build step needed) ─────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  main: {
    padding: "2rem",
    fontFamily: "monospace",
    background: "#111",
    color: "#ccc",
    minHeight: "100vh",
  },
  h1: { margin: "0 0 1.5rem", fontSize: "1.5rem", color: "#fff" },
  h2: { margin: "1.5rem 0 0.5rem", fontSize: "1rem", color: "#aaa" },
  section: { marginBottom: "1.5rem" },
  row: { display: "flex", gap: 12, flexWrap: "wrap" },
  card: {
    border: "1px solid #333",
    padding: "12px 16px",
    borderRadius: 4,
    minWidth: 140,
  },
  cardLabel: { fontSize: 11, color: "#888", marginBottom: 4 },
  cardValue: { fontSize: 18, color: "#fff" },
  btn: {
    margin: "4px 0",
    padding: "4px 14px",
    background: "#333",
    color: "#ccc",
    border: "1px solid #555",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 13,
  },
  code: {
    display: "block",
    marginTop: 8,
    padding: "6px 10px",
    background: "#222",
    fontSize: 16,
    letterSpacing: 2,
    color: "#0f0",
  },
  formRow: { display: "flex", gap: 12, marginBottom: 8 },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 12,
    color: "#888",
    flex: 1,
  },
  input: {
    padding: "4px 8px",
    background: "#222",
    color: "#ccc",
    border: "1px solid #444",
    fontFamily: "monospace",
    fontSize: 13,
    borderRadius: 2,
  },
  pre: {
    marginTop: 8,
    padding: "8px 10px",
    background: "#222",
    fontSize: 12,
    color: "#aaa",
    whiteSpace: "pre-wrap",
  },
  linkRow: { display: "flex", gap: 16, flexWrap: "wrap" },
  link: {
    color: "#6af",
    textDecoration: "none",
    fontSize: 13,
    padding: "4px 0",
  },
};
