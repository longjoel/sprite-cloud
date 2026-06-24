"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

interface DevToolsProps {
  show: boolean;
  onClose: () => void;
}

export default function DevTools({ show, onClose }: DevToolsProps) {
  const [cmdServerId, setCmdServerId] = useState("");
  const [cmdType, setCmdType] = useState("start_game");
  const [cmdPayload, setCmdPayload] = useState('{"game_id":"smw"}');
  const [cmdResult, setCmdResult] = useState("");
  const [playServerId, setPlayServerId] = useState("");
  const [playGameId, setPlayGameId] = useState("smw");
  const [playStatus, setPlayStatus] = useState("");
  const [workerUrl, setWorkerUrl] = useState<string | null>(null);

  if (!show) return null;

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
      document.cookie = `gv_csrf_token=${encodeURIComponent(
        token,
      )}; Path=/; SameSite=Lax`;
    }
    return {
      "Content-Type": "application/json",
      "x-csrf-token": decodeURIComponent(token),
    };
  }

  async function queueCommand() {
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
  }

  async function playGame() {
    setWorkerUrl(null);
    setPlayStatus("");

    if (!NUMERIC_UUID_RE.test(playServerId)) {
      setPlayStatus("Invalid server_id (must be UUID)");
      return;
    }

    setPlayStatus("Queueing…");
    try {
      const qr = await fetch("/api/server/command", {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({
          server_id: playServerId,
          type: "start_game",
          payload: { game_id: playGameId },
        }),
      });
      if (!qr.ok) {
        const err = await qr.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${qr.status}`);
      }

      setPlayStatus("Waiting for worker…");
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const nr = await fetch(
          `/api/server/notify?server_id=${playServerId}`,
        );
        if (nr.ok) {
          const data = await nr.json();
          if (data.worker_url) {
            setWorkerUrl(data.worker_url);
            setPlayStatus("Ready!");
            return;
          }
        }
      }
      setPlayStatus("Timeout — worker did not report URL");
    } catch (e: unknown) {
      setPlayStatus(
        e instanceof Error ? e.message : "Play failed",
      );
    }
  }

  return (
    <div style={S.devSection}>
      {/* Command queue */}
      <h3 style={S.h3}>Command queue</h3>
      <div style={S.formRow}>
        <label style={S.formLabel}>
          server_id
          <input
            style={S.formInput}
            value={cmdServerId}
            onChange={(e) => setCmdServerId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </label>
        <label style={S.formLabel}>
          type
          <select
            style={S.formSelect}
            value={cmdType}
            onChange={(e) => setCmdType(e.target.value)}
          >
            <option value="start_game">start_game</option>
            <option value="stop_game">stop_game</option>
            <option value="sdp_offer">sdp_offer</option>
          </select>
        </label>
      </div>
      <label style={S.formLabel}>
        payload (JSON)
        <textarea
          style={{ ...S.formInput, height: 60 }}
          value={cmdPayload}
          onChange={(e) => setCmdPayload(e.target.value)}
        />
      </label>
      <Button
        variant="secondary"
        size="sm"
        onClick={queueCommand}
      >
        Send
      </Button>
      {cmdResult && (
        <pre style={S.pre}>{cmdResult}</pre>
      )}

      {/* Play game */}
      <h3 style={{ ...S.h3, marginTop: "var(--space-6)" }}>
        Play game
      </h3>
      <div style={S.formRow}>
        <label style={S.formLabel}>
          server_id
          <input
            style={S.formInput}
            value={playServerId}
            onChange={(e) =>
              setPlayServerId(e.target.value)
            }
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </label>
        <label style={S.formLabel}>
          game_id
          <input
            style={{ ...S.formInput, width: 120 }}
            value={playGameId}
            onChange={(e) =>
              setPlayGameId(e.target.value)
            }
          />
        </label>
      </div>
      <Button
        variant="primary"
        size="sm"
        onClick={playGame}
      >
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
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  devSection: {
    marginTop: "var(--space-5)",
    padding: "var(--space-6)",
    background: "var(--color-teak)",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-md)",
  },
  h3: {
    margin: "0 0 var(--space-4)",
    fontSize: "var(--font-size-base)",
    color: "var(--color-brass)",
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase" as const,
  },
  formRow: {
    display: "flex",
    gap: "var(--space-5)",
    marginBottom: "var(--space-4)",
  },
  formLabel: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "var(--space-2)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
    flex: 1,
  },
  formInput: {
    padding: "var(--space-2) var(--space-4)",
    background: "var(--color-walnut)",
    color: "var(--color-cream)",
    border: "1px solid var(--color-bamboo)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-base)",
    borderRadius: "var(--radius-sm)",
  },
  formSelect: {
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
    whiteSpace: "pre-wrap" as const,
    fontFamily: "var(--font-mono)",
  },
  link: {
    color: "var(--color-info)",
    textDecoration: "none",
    fontSize: "var(--font-size-base)",
    fontFamily: "var(--font-mono)",
  },
};
