"use client";

import { useCallback, useEffect, useState } from "react";
import { pollUntil, useInterval } from "@/lib/poll";
import { Button } from "@/components/ui";

// ── Constants (no magic values) ───────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const NUMERIC_UUID_RE = /^[0-9a-f-]{36}$/;

function csrfHeaders(): Record<string, string> {
  let token = document.cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("gv_csrf_token="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!token) {
    token = crypto.randomUUID();
    document.cookie = `gv_csrf_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  }
  return { "Content-Type": "application/json", "x-csrf-token": decodeURIComponent(token) };
}

// ── Types ─────────────────────────────────────────────────────────────

interface StatusCard {
  label: string;
  value: string;
  ok: boolean;
}

// ── Links ──────────────────────────────────────────────────────────────

const LINKS: Array<{ label: string; href: string }> = [
  { label: "Games Vault (v1)", href: "http://localhost:8090" },
  { label: "Jellyfin", href: "http://localhost:8096" },
  { label: "Home Assistant", href: "http://localhost:8123" },
  { label: "gv-test VPS", href: "https://gv-test.lngnckr.tech" },
  { label: "Production", href: "https://lngnckr.tech" },
];

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
    results.push({ label: "gv-web", value: "up", ok: true });

    try {
      const r = await fetch("/api/health");
      if (r.ok) {
        const data = await r.json();
        results.push({ label: "DB", value: "connected", ok: data.status === "ok" });
      } else {
        results.push({ label: "DB", value: `HTTP ${r.status}`, ok: false });
      }
    } catch {
      results.push({ label: "DB", value: "unreachable", ok: false });
    }

    try {
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
  }, [refresh]);

  useInterval(refresh, POLL_INTERVAL_MS);

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
        headers: csrfHeaders(),
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

    setPlayStatus("Queueing…");
    let token: string;
    try {
      const r = await fetch("/api/server/command", {
        method: "POST",
        headers: csrfHeaders(),
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
      token = data.worker_token;
      setWorkerToken(token);
    } catch (e) {
      setPlayStatus(`Network error: ${e}`);
      return;
    }

    const POLL_MS = 500;
    const TIMEOUT_MS = 30_000;
    setPlayStatus("Waiting for worker…");

    try {
      const url = await pollUntil<string>(
        async () => {
          const r = await fetch(
            `/api/server/notify?server_id=${encodeURIComponent(playServerId)}&worker_token=${encodeURIComponent(token)}`,
          );
          const data = await r.json();
          return data.worker_url ?? null;
        },
        { intervalMs: POLL_MS, timeoutMs: TIMEOUT_MS },
      );
      setWorkerUrl(url);
      setPlayStatus("Ready!");
    } catch {
      setPlayStatus("Timed out waiting for worker");
    }
  };

  // ── Render ───────────────────────────────────────────────────────

  return (
    <main style={S.main}>
      <h1 style={S.h1}>Dev Dashboard</h1>

      {/* Status cards */}
      <div style={S.row}>
        {cards.map((c) => (
          <div
            key={c.label}
            style={{
              ...S.card,
              borderColor: c.ok ? "var(--color-success)" : "var(--color-error)",
            }}
          >
            <div style={S.cardLabel}>{c.label}</div>
            <div style={S.cardValue}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Pairing code */}
      <section style={S.section}>
        <h2 style={S.h2}>Pairing Code</h2>
        <Button variant="secondary" size="sm" onClick={generateCode}>
          Generate
        </Button>
        {pairingCode && (
          <code style={S.code}>{pairingCode}</code>
        )}
      </section>

      {/* Command queue */}
      <section style={S.section}>
        <h2 style={S.h2}>Queue Command</h2>
        <div style={S.formRow}>
          <label style={S.label}>
            server_id
            <input
              style={S.input}
              value={cmdServerId}
              onChange={(e) => setCmdServerId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </label>
          <label style={S.label}>
            type
            <select
              style={{ ...S.input, width: 160 }}
              value={cmdType}
              onChange={(e) => setCmdType(e.target.value)}
            >
              <option value="start_game">start_game</option>
              <option value="stop_game">stop_game</option>
              <option value="sdp_offer">sdp_offer</option>
            </select>
          </label>
        </div>
        <label style={S.label}>
          payload (JSON)
          <textarea
            style={{ ...S.input, height: 60 }}
            value={cmdPayload}
            onChange={(e) => setCmdPayload(e.target.value)}
          />
        </label>
        <Button variant="secondary" size="sm" onClick={queueCommand}>
          Send
        </Button>
        {cmdResult && (
          <pre style={S.pre}>{cmdResult}</pre>
        )}
      </section>

      {/* Play Game */}
      <section style={S.section}>
        <h2 style={S.h2}>Play Game</h2>
        <div style={S.formRow}>
          <label style={S.label}>
            server_id
            <input
              style={S.input}
              value={playServerId}
              onChange={(e) => setPlayServerId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </label>
          <label style={S.label}>
            game_id
            <input
              style={{ ...S.input, width: 120 }}
              value={playGameId}
              onChange={(e) => setPlayGameId(e.target.value)}
            />
          </label>
        </div>
        <Button variant="primary" size="sm" onClick={playGame}>
          Play
        </Button>
        {playStatus && (
          <pre style={S.pre}>{playStatus}</pre>
        )}
        {workerUrl && (
          <div style={{ marginTop: "var(--space-4)" }}>
            <a
              style={S.link}
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
      <section style={S.section}>
        <h2 style={S.h2}>Links</h2>
        <div style={S.linkRow}>
          {LINKS.map((l) => (
            <a key={l.href} style={S.link} href={l.href}>
              {l.label}
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  main: {
    padding: "var(--space-8)",
    fontFamily: "var(--font-mono)",
    background: "var(--color-mahogany)",
    color: "var(--color-cream)",
    minHeight: "100vh",
  },
  h1: {
    margin: "0 0 var(--space-7)",
    fontSize: "var(--font-size-h1)",
    color: "var(--color-brass)",
    fontFamily: "var(--font-mono)",
  },
  h2: {
    margin: "var(--space-7) 0 var(--space-3)",
    fontSize: "var(--font-size-h2)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  section: { marginBottom: "var(--space-7)" },
  row: { display: "flex", gap: "var(--space-5)", flexWrap: "wrap" },
  card: {
    border: "1px solid var(--color-bamboo)",
    padding: "var(--space-5) var(--space-6)",
    borderRadius: "var(--radius-md)",
    minWidth: 140,
    background: "var(--color-teak)",
  },
  cardLabel: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-muted)",
    marginBottom: "var(--space-2)",
    fontFamily: "var(--font-mono)",
  },
  cardValue: {
    fontSize: "var(--font-size-xl)",
    color: "var(--color-cream)",
    fontFamily: "var(--font-mono)",
  },
  code: {
    display: "block",
    marginTop: "var(--space-4)",
    padding: "var(--space-3) var(--space-4)",
    background: "var(--color-walnut)",
    fontSize: "var(--font-size-lg)",
    letterSpacing: 2,
    color: "var(--color-lime)",
    fontFamily: "var(--font-mono)",
  },
  formRow: { display: "flex", gap: "var(--space-5)", marginBottom: "var(--space-4)" },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
    flex: 1,
  },
  input: {
    padding: "var(--space-2) var(--space-4)",
    background: "var(--color-walnut)",
    color: "var(--color-cream)",
    border: "1px solid var(--color-bamboo)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-base)",
    borderRadius: "var(--radius-sm)",
  },
  pre: {
    marginTop: "var(--space-4)",
    padding: "var(--space-4)",
    background: "var(--color-walnut)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    whiteSpace: "pre-wrap",
    fontFamily: "var(--font-mono)",
  },
  linkRow: { display: "flex", gap: "var(--space-6)", flexWrap: "wrap" },
  link: {
    color: "var(--color-info)",
    textDecoration: "none",
    fontSize: "var(--font-size-base)",
    fontFamily: "var(--font-mono)",
    padding: "var(--space-2) 0",
  },
};
