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
  role: string; // "admin" | "member"
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
  const s = Math.round(
    (Date.now() - new Date(ts).getTime()) / 1000,
  );
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ── Component ──────────────────────────────────────────────────────────

export default function SettingsClient({ memberships }: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);

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

  return (
    <main style={S.main}>
      <h1 style={S.h1}>Settings</h1>

      {error && <div style={S.error}>{error}</div>}

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
                <th style={S.th}>Role</th>
                <th style={S.th} />
              </tr>
            </thead>
            <tbody>
              {memberships.map((s) => {
                const status = serverStatus(s.lastSeenAt);
                const isAdmin = s.role === "admin";
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
                          style={
                            isAdmin ? S.editableName : undefined
                          }
                          onClick={() =>
                            isAdmin && startRename(s.id, s.name)
                          }
                          title={isAdmin ? "Click to rename" : undefined}
                        >
                          {s.name || s.id.slice(0, 8)}
                        </span>
                      )}
                    </td>
                    <td style={S.td}>
                      {timeAgo(s.lastSeenAt)}
                    </td>
                    <td style={S.td}>
                      <Badge
                        variant={
                          isAdmin ? "info" : "muted"
                        }
                      >
                        {isAdmin ? "admin" : "member"}
                      </Badge>
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
                        {isAdmin && (
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
                        )}
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

      {/* Pairing code */}
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

      <p>
        <a href="/" style={S.link}>
          ← Library
        </a>
      </p>
    </main>
  );
}

// ── API helpers ────────────────────────────────────────────────────────

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

// ── Styles ─────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  main: {
    padding: "var(--space-8)",
    fontFamily: "var(--font-mono)",
    background: "var(--color-mahogany)",
    color: "var(--color-cream)",
    minHeight: "100vh",
    maxWidth: 960,
    margin: "0 auto",
  },
  h1: {
    margin: "0 0 var(--space-8)",
    fontSize: "var(--font-size-h1)",
    color: "var(--color-brass)",
    fontFamily: "var(--font-mono)",
  },
  h2: {
    margin: "0 0 var(--space-6)",
    fontSize: "var(--font-size-h2)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  section: { marginBottom: "var(--space-8)" },
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
  link: {
    color: "var(--color-info)",
    textDecoration: "none",
    fontSize: "var(--font-size-base)",
    fontFamily: "var(--font-mono)",
  },
};
