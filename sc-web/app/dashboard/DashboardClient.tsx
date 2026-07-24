"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import ServerPanel from "./ServerPanel";
import DevTools from "./DevTools";
import { serverStatus, timeAgo, csrfHeaders } from "./dashboard-utils";
import { probeLanHealth, type LanProbeResult } from "@/lib/lan/probe";

// ── Types ──────────────────────────────────────────────────────────────

interface Membership {
  id: string;
  name: string;
  romRoots: string[];
  lastSeenAt: string | null;
  role: string;
}

interface ServerMetadataSummary {
  version?: string;
  public_ip?: string;
  rom_roots?: string[];
  lan?: {
    player_port?: number;
    player_urls?: string[];
    health_urls?: string[];
    lan_player_enabled?: boolean;
  };
  ice?: {
    turn_configured?: boolean;
    transport_policy?: string;
  };
  runtime?: {
    pc_pool_size?: number;
  };
}

interface Props {
  memberships: Membership[];
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
  const [showDevTools, setShowDevTools] = useState(false);
  const [metadataByServer, setMetadataByServer] = useState<Record<string, ServerMetadataSummary>>({});
  const [lanProbeByServer, setLanProbeByServer] = useState<Record<string, LanProbeResult>>({});

  useEffect(() => {
    let cancelled = false;

    async function loadMetadata() {
      const entries = await Promise.all(
        memberships.map(async (membership) => {
          try {
            const resp = await fetch(`/api/servers/${membership.id}/metadata`);
            if (!resp.ok) return [membership.id, null] as const;
            const data = await resp.json();
            return [membership.id, (data?.metadata ?? null) as ServerMetadataSummary | null] as const;
          } catch {
            return [membership.id, null] as const;
          }
        }),
      );

      if (cancelled) return;
      const nextMetadata: Record<string, ServerMetadataSummary> = {};
      for (const [id, metadata] of entries) {
        if (metadata) nextMetadata[id] = metadata;
      }
      setMetadataByServer(nextMetadata);

      const probeEntries = await Promise.all(
        Object.entries(nextMetadata).map(async ([id, metadata]) => {
          if (!metadata.lan?.health_urls?.length) return [id, { reachable: false, reason: "no_urls" } as LanProbeResult] as const;
          const result = await probeLanHealth(metadata.lan.health_urls, { timeoutMs: 1_200 });
          return [id, result] as const;
        }),
      );
      if (cancelled) return;
      setLanProbeByServer(Object.fromEntries(probeEntries));
    }

    if (memberships.length > 0) {
      loadMetadata();
    } else {
      setMetadataByServer({});
      setLanProbeByServer({});
    }

    return () => {
      cancelled = true;
    };
  }, [memberships]);

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

  function renderSummaryPills(serverId: string, romRoots: string[]) {
    const metadata = metadataByServer[serverId];
    const lanProbe = lanProbeByServer[serverId];
    const pills: Array<{ label: string; tone?: "info" | "success" | "warning" | "muted" }> = [];

    pills.push({
      label: `${metadata?.rom_roots?.length ?? romRoots.length} root${(metadata?.rom_roots?.length ?? romRoots.length) === 1 ? "" : "s"}`,
      tone: "muted",
    });

    if (metadata?.version) {
      pills.push({ label: `server ${metadata.version}`, tone: "info" });
    }
    if (metadata?.lan?.health_urls?.length) {
      if (!lanProbe) {
        pills.push({ label: "LAN probing…", tone: "muted" });
      } else if (lanProbe.reachable) {
        pills.push({ label: `LAN ${lanProbe.latencyMs.toFixed(0)}ms`, tone: "success" });
      } else if (lanProbe.reason === "mixed_content_blocked") {
        pills.push({ label: "LAN blocked by HTTPS", tone: "warning" });
      } else {
        pills.push({ label: "LAN fallback", tone: "warning" });
      }
    }
    if (metadata?.public_ip) {
      pills.push({ label: metadata.public_ip, tone: "info" });
    }
    if (metadata?.ice) {
      pills.push({
        label: metadata.ice.turn_configured ? "TURN ready" : "TURN missing",
        tone: metadata.ice.turn_configured ? "success" : "warning",
      });
      if (metadata.ice.transport_policy) {
        pills.push({ label: `ICE ${metadata.ice.transport_policy}`, tone: "muted" });
      }
    }
    if (metadata?.runtime?.pc_pool_size !== undefined) {
      pills.push({ label: `pool ${metadata.runtime.pc_pool_size}`, tone: "muted" });
    }

    return (
      <div style={S.pillRow}>
        {pills.map((pill) => (
          <span key={pill.label} style={{ ...S.pill, ...(pill.tone ? S.pillTones[pill.tone] : {}) }}>
            {pill.label}
          </span>
        ))}
      </div>
    );
  }

  return (
    <>
      {error && <div style={S.error}>{error}</div>}

      <section style={S.section}>
        <div style={S.sectionHeader}>
          <div>
            <h2 style={S.h2}>Servers</h2>
            <p style={S.sectionSub}>
              Status, identity, routing, and ROM roots live here. Expand a row only when you need deeper controls.
            </p>
          </div>
          <div style={S.inlineTools}>
            <Button
              variant="secondary"
              size="sm"
              onClick={generatePairingCode}
            >
              Generate pairing code
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDevTools(!showDevTools)}
            >
              {showDevTools ? "Hide dev tools" : "Dev tools"}
            </Button>
          </div>
        </div>

        {pairingCode && (
          <div style={S.pairingCommand}>
            <div style={S.pairingTopRow}>
              <span style={S.pairingLabel}>Pairing code</span>
              <code style={S.pairingCode}>{pairingCode}</code>
            </div>
            <p style={S.pairingHint}>
              Run this on the machine with your ROMs:
            </p>
            <code style={S.pairingCmd}>
              sc-server pair {pairingCode} --sc-web-url {window.location.origin}
            </code>
          </div>
        )}

        {pairingError && (
          <div style={S.pairingError}>Error: {pairingError}</div>
        )}

        {memberships.length === 0 ? (
          <p style={S.empty}>
            No servers. Pair a sc-server first.
          </p>
        ) : (
          <div style={S.tableCard}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.thStatus}>Status</th>
                  <th style={S.thServer}>Server</th>
                  <th style={S.thSeen}>Last seen</th>
                  <th style={S.thActions}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {memberships.map((s) => {
                  const status = serverStatus(s.lastSeenAt);
                  const isOpen = expanded.has(s.id);
                  const metadata = metadataByServer[s.id];

                  return (
                    <>
                      <tr key={s.id} style={isOpen ? S.rowExpanded : undefined}>
                        <td style={S.tdStatus}>
                          <div style={S.statusStack}>
                            <span
                              style={{
                                ...S.statusDot,
                                background: status.color,
                              }}
                            />
                            <span style={S.statusLabel}>{status.label}</span>
                          </div>
                        </td>
                        <td style={S.tdServer}>
                          <div style={S.serverCell}>
                            <div style={S.serverTitleRow}>
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
                                      if (e.key === "Escape") setEditing(null);
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
                              <code style={S.serverId}>{s.id.slice(0, 8)}</code>
                            </div>
                            {renderSummaryPills(s.id, s.romRoots)}
                            {metadata?.public_ip && (
                              <p style={S.serverNote}>
                                Public route: <code style={S.inlineCode}>{metadata.public_ip}</code>
                              </p>
                            )}
                          </div>
                        </td>
                        <td style={S.tdSeen}>
                          <div style={S.seenStack}>
                            <span>{timeAgo(s.lastSeenAt)}</span>
                            <span style={S.seenSub}>
                              {s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : "No heartbeat yet"}
                            </span>
                          </div>
                        </td>
                        <td style={S.tdActions}>
                          <div style={S.actionRow}>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => toggle(s.id)}
                            >
                              {isOpen ? "Hide details" : "Details"}
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
                      {isOpen && (
                        <tr key={`${s.id}-panel`}>
                          <td colSpan={4} style={S.panelCell}>
                            <div style={S.panelShell}>
                              <div style={S.panelIntro}>
                                <h3 style={S.panelTitle}>Server details</h3>
                                <p style={S.panelText}>
                                  Browse ROM roots, inspect ICE/runtime metadata, and adjust core overrides for {s.name || s.id.slice(0, 8)}.
                                </p>
                              </div>
                              <ServerPanel
                                serverId={s.id}
                                romRoots={s.romRoots}
                              />
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

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

      {showDevTools && (
        <section style={S.section}>
          <div style={S.devToolsCard}>
            <h2 style={S.h2}>Dev tools</h2>
            <DevTools show={showDevTools} onClose={() => setShowDevTools(false)} />
          </div>
        </section>
      )}
    </>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────

const S = {
  section: { marginBottom: "var(--space-8)" },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "var(--space-5)",
    marginBottom: "var(--space-5)",
    flexWrap: "wrap",
  },
  inlineTools: {
    display: "flex",
    gap: "var(--space-3)",
    alignItems: "center",
    flexWrap: "wrap",
  },
  h2: {
    margin: 0,
    fontSize: "var(--font-size-h2)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  sectionSub: {
    margin: "8px 0 0",
    maxWidth: 720,
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-base)",
    lineHeight: 1.5,
  },
  tableCard: {
    border: "1px solid var(--color-sky-high)",
    background: "var(--color-sky-mid)",
    overflow: "hidden",
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
  thStatus: {
    textAlign: "left" as const,
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--color-sky-high)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
    width: "120px",
  },
  thServer: {
    textAlign: "left" as const,
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--color-sky-high)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  thSeen: {
    textAlign: "left" as const,
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--color-sky-high)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
    width: "200px",
  },
  thActions: {
    textAlign: "left" as const,
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--color-sky-high)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
    width: "180px",
  },
  rowExpanded: {
    background: "rgba(56,189,248,0.04)",
  },
  tdStatus: {
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--color-sky-high)",
    fontSize: "var(--font-size-base)",
    verticalAlign: "top" as const,
  },
  tdServer: {
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--color-sky-high)",
    fontSize: "var(--font-size-base)",
    verticalAlign: "top" as const,
  },
  tdSeen: {
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--color-sky-high)",
    fontSize: "var(--font-size-base)",
    verticalAlign: "top" as const,
  },
  tdActions: {
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--color-sky-high)",
    fontSize: "var(--font-size-base)",
    verticalAlign: "top" as const,
  },
  statusStack: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  statusDot: {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
  },
  statusLabel: {
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    fontSize: "var(--font-size-xs)",
    color: "var(--color-cloud)",
    fontFamily: "var(--font-mono)",
  },
  serverCell: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "var(--space-2)",
  },
  serverTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    flexWrap: "wrap" as const,
  },
  editableName: {
    cursor: "pointer",
    borderBottom: "1px dashed var(--color-sky-high)",
    color: "var(--color-cloud)",
    fontWeight: 600,
    fontSize: "var(--font-size-lg)",
  },
  serverId: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-cloud-dim)",
    background: "var(--color-sky-deep)",
    padding: "2px 6px",
    borderRadius: "2px",
  },
  pillRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "var(--space-2)",
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 8px",
    border: "1px solid var(--color-sky-high)",
    fontSize: "var(--font-size-xs)",
    fontFamily: "var(--font-mono)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
  },
  pillTones: {
    info: {
      color: "var(--color-info)",
      background: "var(--color-infoBg)",
      border: "1px solid rgba(56,189,248,0.28)",
    },
    success: {
      color: "var(--color-success)",
      background: "var(--color-successBg)",
      border: "1px solid rgba(34,197,94,0.28)",
    },
    warning: {
      color: "var(--color-warning)",
      background: "var(--color-warningBg)",
      border: "1px solid rgba(245,158,11,0.28)",
    },
    muted: {
      color: "var(--color-cloud-dim)",
      background: "rgba(148,163,184,0.08)",
      border: "1px solid rgba(148,163,184,0.18)",
    },
  },
  serverNote: {
    margin: 0,
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-sm)",
  },
  inlineCode: {
    color: "var(--color-info)",
    fontFamily: "var(--font-mono)",
  },
  seenStack: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "var(--space-1)",
  },
  seenSub: {
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-xs)",
    fontFamily: "var(--font-mono)",
  },
  inlineForm: { display: "inline" },
  inlineInput: {
    padding: "2px 6px",
    background: "var(--color-sky-high)",
    color: "var(--color-cloud)",
    border: "1px solid var(--color-accent)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-base)",
    width: 220,
  },
  actionRow: {
    display: "flex",
    gap: "var(--space-3)",
    flexWrap: "wrap" as const,
  },
  panelCell: {
    padding: 0,
    borderBottom: "1px solid var(--color-sky-high)",
  },
  panelShell: {
    padding: "var(--space-6)",
    background: "rgba(10,14,26,0.75)",
    borderTop: "1px solid rgba(56,189,248,0.12)",
  },
  panelIntro: {
    marginBottom: "var(--space-5)",
  },
  panelTitle: {
    margin: 0,
    color: "var(--color-accent)",
    fontSize: "var(--font-size-lg)",
    fontFamily: "var(--font-mono)",
  },
  panelText: {
    margin: "8px 0 0",
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-base)",
    lineHeight: 1.5,
  },
  confirmBox: {
    background: "var(--color-sky-mid)",
    border: "1px solid var(--color-error)",
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
    flexWrap: "wrap" as const,
  },
  confirmInput: {
    padding: "var(--space-2) var(--space-4)",
    background: "var(--color-sky-high)",
    color: "var(--color-cloud)",
    border: "1px solid var(--color-error)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-base)",
    width: 160,
  },
  pairingCommand: {
    marginBottom: "var(--space-5)",
    padding: "var(--space-5)",
    background: "var(--color-sky-deep)",
    border: "1px solid var(--color-accent)",
  },
  pairingTopRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    flexWrap: "wrap" as const,
    marginBottom: "var(--space-3)",
  },
  pairingLabel: {
    color: "var(--color-cloud-dim)",
    fontSize: "var(--font-size-sm)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    fontFamily: "var(--font-mono)",
  },
  pairingCode: {
    fontSize: "var(--font-size-lg)",
    fontFamily: "var(--font-mono)",
    color: "var(--color-lime)",
    letterSpacing: "0.15em",
  },
  pairingHint: {
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    margin: "0 0 var(--space-3)",
  },
  pairingCmd: {
    display: "block",
    fontSize: "var(--font-size-md)",
    fontFamily: "var(--font-mono)",
    color: "var(--color-lime)",
    background: "#0d0a06",
    padding: "var(--space-4) var(--space-5)",
    wordBreak: "break-all" as const,
  },
  pairingError: {
    marginBottom: "var(--space-5)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-error)",
  },
  devToolsCard: {
    padding: "var(--space-5)",
    background: "rgba(10,14,26,0.45)",
    border: "1px solid rgba(56,189,248,0.12)",
  },
} satisfies Record<string, React.CSSProperties | Record<string, React.CSSProperties>>;
