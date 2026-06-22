"use client";

import { useState, useEffect } from "react";
import { pollUntil } from "@/lib/poll";
import { Badge, Button, Input } from "@/components/ui";

// ── Types ──────────────────────────────────────────────────────────────

interface ComponentVersion {
  package_version: string;
  git_sha?: string;
  artifact_sha256?: string;
  built_at_utc?: string;
  released_at_utc?: string;
  binary_path?: string;
}

interface ServerMetadata {
  version: string;
  lan_addresses: string[];
  rom_roots: string[];
  ice: {
    stun_urls: string[];
    turn_urls: string[];
    turn_configured: boolean;
    transport_policy: string;
  };
  versions?: {
    server?: ComponentVersion;
    worker?: ComponentVersion;
    runner?: ComponentVersion;
  };
}

interface TreeNode {
  name: string;
  type: "dir" | "file" | "error";
  children?: TreeNode[];
}

interface ScanMatch {
  name: string;
  game_name: string;
}

interface ScanFile {
  relative_path: string;
  file_name: string;
  file_size: number;
  platform: string | null;
}

interface ScanResult {
  file: ScanFile;
  match: ScanMatch | null;
}

interface Props {
  serverId: string;
  serverName: string;
  romRoots: string[];
}

// ── Component ──────────────────────────────────────────────────────────

export default function ServerManager({
  serverId,
  serverName,
  romRoots,
}: Props) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [browsing, setBrowsing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<ScanResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [added, setAdded] = useState(false);
  const [importing, setImporting] = useState(false);
  const [metadata, setMetadata] = useState<ServerMetadata | null>(null);

  // Fetch server metadata on mount
  useEffect(() => {
    fetch(`/api/servers/${serverId}/metadata`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.metadata) setMetadata(d.metadata); })
      .catch(() => {});
  }, [serverId]);

  async function browse(path: string) {
    setBrowsing(true);
    setError(null);
    setTree(null);
    try {
      const cmd = await enqueueCommand(serverId, "browse_files", { path });
      const result = await pollResult(cmd.id);
      if (result?.tree) {
        setTree(result.tree);
      } else if (result?.error) {
        setError(result.error);
      } else {
        setError("Unexpected response from server.");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Browse failed.");
    } finally {
      setBrowsing(false);
    }
  }

  async function scan() {
    const paths = Array.from(checked);
    if (paths.length === 0) return;

    setScanning(true);
    setError(null);
    setResults(null);
    try {
      const cmd = await enqueueCommand(serverId, "scan_paths", { paths });
      const result = await pollResult(cmd.id);
      if (result?.matches) {
        setResults(result.matches);
        // Auto-import after scan — no separate "Import to Library" step.
        await importFiles(result.matches);
      } else if (result?.error) {
        setError(result.error);
      } else {
        setError("Unexpected response from server.");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Scan failed.");
    } finally {
      setScanning(false);
    }
  }

  function toggle(path: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function importFiles(matches: typeof results) {
    if (!matches) return;
    setImporting(true);
    setError(null);
    try {
      const files = matches.map((r) => ({
        dat_name: r.match?.name ?? undefined,
        name: overrides[r.file.relative_path] ?? r.match?.name ?? r.file.file_name,
        platform: r.file.platform ?? "Unknown",
        rom_path: r.file.relative_path,
        file_name: r.file.file_name,
        file_size: r.file.file_size,
      }));
      const resp = await fetch("/api/library/import", {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({ server_id: serverId, files }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      setAdded(true);
      setError(`${data.imported} imported, ${data.skipped} skipped`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  async function importToLibrary() {
    await importFiles(results);
  }

  return (
    <main style={S.main}>
      <h1 style={S.h1}>{serverName || serverId.slice(0, 8)}</h1>

      {error && (
        <div style={S.error}>{error}</div>
      )}

      <section style={S.section}>
        <h2 style={S.h2}>ROM roots</h2>
        {romRoots.length === 0 ? (
          <p style={S.empty}>
            No ROM roots configured. Set GV_ROM_ROOTS on the server.
          </p>
        ) : (
          <ul style={S.rootList}>
            {romRoots.map((root) => (
              <li key={root} style={S.rootItem}>
                <code style={S.path}>{root}</code>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => browse(root)}
                  disabled={browsing}
                >
                  {browsing ? "Browsing..." : "Browse"}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setChecked(new Set([root]));
                    scan();
                  }}
                  disabled={scanning}
                >
                  {scanning ? "Scanning..." : "Scan all"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Server metadata */}
      {metadata && (
        <section style={S.section}>
          <h2 style={S.h2}>Connectivity</h2>
          <table style={S.metaTable}>
            <tbody>
              <MetadataRow label="Version" value={metadata.version} />
              <MetadataRow
                label="LAN"
                value={metadata.lan_addresses?.join(", ") || "—"}
              />
              <MetadataRow
                label="STUN"
                value={metadata.ice?.stun_urls?.join(", ") || "—"}
              />
              <MetadataRow
                label="TURN"
                value={
                  metadata.ice?.turn_configured
                    ? (metadata.ice?.turn_urls?.join(", ") || "—")
                    : "not configured"
                }
              />
              <MetadataRow
                label="ICE policy"
                value={metadata.ice?.transport_policy || "—"}
              />
            </tbody>
          </table>
        </section>
      )}


      {metadata?.versions && (metadata.versions.server || metadata.versions.worker || metadata.versions.runner) && (
        <section style={S.section}>
          <h2 style={S.h2}>Components</h2>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Component</th>
                <th style={S.th}>Package</th>
                <th style={S.th}>Commit</th>
                <th style={S.th}>Built</th>
                <th style={S.th}>Path</th>
              </tr>
            </thead>
            <tbody>
              {([
                ["server", metadata.versions.server],
                ["worker", metadata.versions.worker],
                ["runner", metadata.versions.runner],
              ] as const)
                .filter(([, version]) => Boolean(version))
                .map(([component, version]) => (
                  <tr key={component}>
                    <td style={S.td}>{component}</td>
                    <td style={S.td}>
                      <code style={S.fileName}>{version?.package_version ?? "—"}</code>
                    </td>
                    <td style={S.td}>
                      <code style={S.fileName}>{version?.git_sha?.slice(0, 7) ?? "—"}</code>
                    </td>
                    <td style={S.td}>{version?.built_at_utc ?? version?.released_at_utc ?? "—"}</td>
                    <td style={S.td}>
                      {version?.binary_path ? (
                        <code style={S.fileName}>{version.binary_path}</code>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}

      {/* File tree */}
      {tree && !results && (
        <section style={S.section}>
          <h2 style={S.h2}>Files</h2>
          <TreeView node={tree} checked={checked} onToggle={toggle} />
          {checked.size > 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={scan}
              disabled={scanning}
              style={{ marginTop: "var(--space-5)" }}
            >
              {scanning ? "Scanning..." : `Scan selected (${checked.size})`}
            </Button>
          )}
        </section>
      )}

      {/* Scan results */}
      {results && (
        <section style={S.section}>
          <h2 style={S.h2}>Results ({results.length} files)</h2>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>File</th>
                <th style={S.th}>Platform</th>
                <th style={S.th}>Match</th>
                <th style={S.th} />
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const key = r.file.relative_path;
                const name = overrides[key] ?? r.match?.name ?? r.file.file_name;
                return (
                  <tr key={key}>
                    <td style={S.td}>
                      <code style={S.fileName}>{r.file.file_name}</code>
                    </td>
                    <td style={S.td}>
                      {r.file.platform ?? "—"}
                    </td>
                    <td style={S.td}>
                      <Input
                        value={name}
                        onChange={(e) =>
                          setOverrides((prev) => ({
                            ...prev,
                            [key]: e.target.value,
                          }))
                        }
                        style={{ padding: "2px 6px", fontSize: "var(--font-size-base)" }}
                      />
                    </td>
                    <td style={S.td}>
                      {r.match ? (
                        <Badge variant="success">✓ DAT</Badge>
                      ) : (
                        <span style={S.noMatch}>manual</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <Button
            variant="primary"
            size="md"
            onClick={importToLibrary}
            disabled={added || importing}
            style={{ marginTop: "var(--space-5)" }}
          >
            {importing ? "Importing..." : added ? "✓ Added" : "Add to library"}
          </Button>
          {added && (
            <p style={S.note}>
              Games added.{" "}
              <a href="/" style={S.link}>
                View library
              </a>
            </p>
          )}
        </section>
      )}

      <p>
        <a href="/settings" style={S.link}>
          ← Settings
        </a>
      </p>
    </main>
  );
}

// ── Metadata row ───────────────────────────────────────────────────────

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td style={S.metaLabel}>{label}</td>
      <td style={S.metaValue}>{value}</td>
    </tr>
  );
}

// ── Tree view ──────────────────────────────────────────────────────────

function TreeView({
  node,
  checked,
  onToggle,
  depth = 0,
}: {
  node: TreeNode;
  checked: Set<string>;
  onToggle: (path: string) => void;
  depth?: number;
}) {
  return (
    <div>
      <div
        style={{ ...S.treeRow, paddingLeft: depth * 16 + 8 }}
        onClick={() => node.type === "dir" && onToggle(node.name)}
      >
        {node.type === "dir" && (
          <span style={S.checkbox}>
            {checked.has(node.name) ? "☑" : "☐"}
          </span>
        )}
        <span style={S.treeIcon}>
          {node.type === "dir" ? "📁" : node.type === "error" ? "⚠" : "📄"}
        </span>
        <span
          style={{
            ...S.treeName,
            color: node.type === "error" ? "var(--color-error)" : undefined,
          }}
        >
          {node.name}
        </span>
      </div>
      {node.children?.map((child, i) => (
        <TreeView
          key={`${child.name}-${i}`}
          node={child}
          checked={checked}
          onToggle={onToggle}
          depth={depth + 1}
        />
      ))}
    </div>
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
    document.cookie = `gv_csrf_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  }
  return { "Content-Type": "application/json", "x-csrf-token": decodeURIComponent(token) };
}

async function enqueueCommand(
  serverId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const resp = await fetch("/api/server/command", {
    method: "POST",
    headers: csrfHeaders(),
    body: JSON.stringify({ server_id: serverId, type, payload }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function pollResult(
  commandId: string,
  maxTries = 30,
): Promise<any> {
  return pollUntil(
    async () => {
      const resp = await fetch(`/api/commands/${commandId}/result`);
      if (resp.status === 404) return null; // not ready yet
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      return (data.result !== null && data.result !== undefined) ? data.result : null;
    },
    { intervalMs: 1000, maxAttempts: maxTries },
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
  rootList: { listStyle: "none", padding: 0, margin: 0 },
  rootItem: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    padding: "var(--space-4) 0",
    borderBottom: "1px solid var(--color-teak)",
  },
  path: {
    fontSize: "var(--font-size-base)",
    color: "var(--color-info)",
    flex: 1,
  },
  treeRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "3px 0",
    cursor: "pointer",
    fontSize: "var(--font-size-base)",
  },
  treeIcon: { fontSize: "var(--font-size-base)" },
  treeName: { fontSize: "var(--font-size-base)" },
  checkbox: { width: 16, fontSize: "var(--font-size-sm)", color: "var(--color-muted)" },
  table: { width: "100%", borderCollapse: "collapse" as const },
  th: {
    textAlign: "left" as const,
    padding: "var(--space-3) var(--space-5)",
    borderBottom: "1px solid var(--color-bamboo)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  td: {
    padding: "var(--space-3) var(--space-5)",
    borderBottom: "1px solid var(--color-teak)",
    fontSize: "var(--font-size-base)",
  },
  fileName: { fontSize: "var(--font-size-sm)", color: "var(--color-info)" },
  noMatch: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-muted)",
    fontStyle: "italic",
  },
  note: {
    fontSize: "var(--font-size-base)",
    color: "var(--color-success)",
    marginTop: "var(--space-4)",
  },
  link: {
    color: "var(--color-info)",
    textDecoration: "none",
    fontSize: "var(--font-size-base)",
    fontFamily: "var(--font-mono)",
  },
  metaTable: { borderCollapse: "collapse" as const, fontSize: "var(--font-size-base)" },
  metaLabel: {
    padding: "2px var(--space-6) 2px 0",
    color: "var(--color-muted)",
    textAlign: "right" as const,
    whiteSpace: "nowrap" as const,
  },
  metaValue: {
    padding: "2px 0",
    color: "var(--color-cream)",
    wordBreak: "break-all" as const,
  },
};
