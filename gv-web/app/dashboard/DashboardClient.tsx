"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@/components/ui";
import ServerPanel from "./ServerPanel";

// ── Types ──────────────────────────────────────────────────────────────

interface Membership {
  id: string;
  name: string;
  romRoots: string[];
  lastSeenAt: string | null;
  role: string;
}

interface Props {
  memberships: Membership[];
}

// ── Helpers ────────────────────────────────────────────────────────────

function serverStatus(
  lastSeenAt: string | null,
): { label: string; color: string } {
  if (!lastSeenAt) return { label: "offline", color: "var(--color-error)" };
  const age = Date.now() - new Date(lastSeenAt).getTime();
  if (age < 120_000)
    return { label: "online", color: "var(--color-success)" };
  return { label: "stale", color: "var(--color-warning)" };
}

function timeAgo(ts: string | null): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

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

// ── Component ──────────────────────────────────────────────────────────

export default function DashboardClient({ memberships }: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);

  // Dev tools state
  const [showDevTools, setShowDevTools] = useState(false);
  const [cmdServerId, setCmdServerId] = useState("");
  const [cmdType, setCmdType] = useState("start_game");
  const [cmdPayload, setCmdPayload] = useState('{"game_id":"smw"}');
  const [cmdResult, setCmdResult] = useState("");
  const [playServerId, setPlayServerId] = useState("");
  const [playGameId, setPlayGameId] = useState("smw");
  const [playStatus, setPlayStatus] = useState("");
  const [workerUrl, setWorkerUrl] = useState<string | null>(null);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function doRename(serverId: string) {
    if (!editName.trim()) return;
    setError(null);
    try {
      const resp = await fetch(`/api/servers/${serverId}`, {
        method: "PATCH",
        headers: csrfHeaders(),
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      setEditing(null);
      router.refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Rename failed");
    }
  }

  function startRename(id: string, currentName: string) {
    setEditing(id);
    setEditName(currentName);
    setError(null);
  }

  async function doDelete(serverId: string) {
    if (deleteConfirm !== "DELETE") return;
    setError(null);
    try {
      const resp = await fetch(`/api/servers/${serverId}`, {
        method: "DELETE",
        headers: csrfHeaders(),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      setDeleting(null);
      router.refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function generatePairingCode() {
    setPairingError(null);
    setPairingCode(null);
    try {
      const resp = await fetch("/api/auth/pair/generate", {
        method: "POST",
        headers: csrfHeaders(),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      setPairingCode(data.code);
    } catch (e: unknown) {
      setPairingError(
        e instanceof Error ? e.message : "Generate failed",
      );
    }
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
      const cmd = await qr.json();

      // Poll for worker URL
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
    <>
      {error && <div style={S.error}>{error}</div>}

      {/* ── Servers ──────────────────────────────────────────────── */}
      <section style={S.section}>
        <h2 style={S.h2}>Servers</h2>
        {memberships.length === 0 ? (
          <p style={S.empty}>
            No servers. Pair a gv-server first.
          </p>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Status</th>
                <th style={S.th}>Name</th>
                <th style={S.th}>Last seen</th>
                <th style={S.th} />
              </tr>
            </thead>
            <tbody>
              {memberships.map((s) => {
                const status = serverStatus(s.lastSeenAt);
                const isOpen = expanded.has(s.id);

                return (
                  <tr key={s.id}>
                    <td style={S.td}>
                      <span
                        style={{
                          ...S.statusDot,
                          background: status.color,
                        }}
                      />{" "}
                      {status.label}
                    </td>
                    <td style={S.td}>
                      {editing === s.id ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            doRename(s.id);
                          }}
                          style={S.inlineForm}
                        >
                          <input
                            style={S.inlineInput}
                            value={editName}
                            onChange={(e) =>
                              setEditName(e.target.value)
                            }
                            autoFocus
                            onBlur={() => setEditing(null)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape")
                                setEditing(null);
                            }}
                          />
                        </form>
                      ) : (
                        <span
                          style={S.editableName}
                          onClick={() =>
                            startRename(s.id, s.name)
                          }
                          title="Click to rename"
                        >
                          {s.name || s.id.slice(0, 8)}
                        </span>
                      )}
                    </td>
                    <td style={S.td}>
                      {timeAgo(s.lastSeenAt)}
                    </td>
                    <td style={S.td}>
                      <div style={S.actionRow}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => toggle(s.id)}
                        >
                          {isOpen ? "Collapse" : "Manage"}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => {
                            setDeleting(s.id);
                            setDeleteConfirm("");
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Delete confirmation */}
      {deleting && (
        <section style={S.section}>
          <h2 style={S.h2}>Confirm removal</h2>
          <div style={S.confirmBox}>
            <p style={S.confirmText}>
              This permanently deletes the server, its ROM roots,
              game files, sessions, and commands. Type DELETE to
              confirm.
            </p>
            <div style={S.confirmRow}>
              <input
                style={S.confirmInput}
                value={deleteConfirm}
                onChange={(e) =>
                  setDeleteConfirm(e.target.value)
                }
                placeholder='Type "DELETE"'
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") doDelete(deleting);
                  if (e.key === "Escape") setDeleting(null);
                }}
              />
              <Button
                variant="destructive"
                size="sm"
                onClick={() => doDelete(deleting)}
              >
                Confirm
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setDeleting(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* Expanded panels */}
      {memberships
        .filter((s) => expanded.has(s.id))
        .map((s) => (
          <section key={s.id} style={S.panel}>
            <h2 style={S.h2}>
              {s.name || s.id.slice(0, 8)}{" "}
              <span style={S.panelBadge}>
                {s.id.slice(0, 8)}
              </span>
            </h2>
            <ServerPanel
              serverId={s.id}
              romRoots={s.romRoots}
            />
          </section>
        ))}

      {/* ── Pairing ──────────────────────────────────────────────── */}
      <section style={S.section}>
        <h2 style={S.h2}>Pairing</h2>
        <div style={S.pairingRow}>
          <Button
            variant="secondary"
            size="sm"
            onClick={generatePairingCode}
          >
            Generate pairing code
          </Button>
          {pairingCode && (
            <code style={S.pairingCode}>{pairingCode}</code>
          )}
          {pairingError && (
            <span style={S.pairingError}>
              Error: {pairingError}
            </span>
          )}
        </div>
      </section>

      {/* ── Dev tools ────────────────────────────────────────────── */}
      <section style={S.section}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowDevTools(!showDevTools)}
        >
          {showDevTools ? "Hide dev tools" : "Dev tools"}
        </Button>
        {showDevTools && (
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
        )}
      </section>

    </>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  section: { marginBottom: "var(--space-8)" },
  h2: {
    margin: "0 0 var(--space-6)",
    fontSize: "var(--font-size-h2)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  h3: {
    margin: "0 0 var(--space-4)",
    fontSize: "var(--font-size-base)",
    color: "var(--color-brass)",
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase" as const,
  },
  panel: {
    marginBottom: "var(--space-8)",
    padding: "var(--space-6)",
    background: "var(--color-teak)",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-md)",
  },
  panelBadge: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  empty: {
    fontSize: "var(--font-size-base)",
    color: "var(--color-muted)",
    fontStyle: "italic",
  },
  error: {
    padding: "var(--space-4) var(--space-5)",
    background: "var(--color-errorBg)",
    border: "1px solid var(--color-error)",
    borderRadius: "var(--radius-md)",
    marginBottom: "var(--space-6)",
    fontSize: "var(--font-size-base)",
    color: "var(--color-error)",
  },
  table: { width: "100%", borderCollapse: "collapse" as const },
  th: {
    textAlign: "left" as const,
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--color-bamboo)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  td: {
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--color-teak)",
    fontSize: "var(--font-size-base)",
  },
  statusDot: {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    marginRight: "var(--space-2)",
  },
  editableName: {
    cursor: "pointer",
    borderBottom: "1px dashed var(--color-bamboo)",
  },
  inlineForm: { display: "inline" },
  inlineInput: {
    padding: "2px 6px",
    background: "var(--color-walnut)",
    color: "var(--color-cream)",
    border: "1px solid var(--color-brass)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-base)",
    borderRadius: "var(--radius-sm)",
    width: 180,
  },
  actionRow: { display: "flex", gap: "var(--space-3)" },
  confirmBox: {
    background: "var(--color-teak)",
    border: "1px solid var(--color-error)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-6)",
  },
  confirmText: {
    fontSize: "var(--font-size-base)",
    color: "var(--color-error)",
    marginBottom: "var(--space-5)",
  },
  confirmRow: {
    display: "flex",
    gap: "var(--space-4)",
    alignItems: "center",
  },
  confirmInput: {
    padding: "var(--space-2) var(--space-4)",
    background: "var(--color-walnut)",
    color: "var(--color-cream)",
    border: "1px solid var(--color-error)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-base)",
    borderRadius: "var(--radius-sm)",
    width: 160,
  },
  pairingRow: {
    display: "flex",
    gap: "var(--space-5)",
    alignItems: "center",
  },
  pairingCode: {
    fontSize: "var(--font-size-lg)",
    fontFamily: "var(--font-mono)",
    color: "var(--color-lime)",
    letterSpacing: "0.15em",
  },
  pairingError: {
    fontSize: "var(--font-size-sm)",
    color: "var(--color-error)",
  },
  devSection: {
    marginTop: "var(--space-5)",
    padding: "var(--space-6)",
    background: "var(--color-teak)",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-md)",
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
};
