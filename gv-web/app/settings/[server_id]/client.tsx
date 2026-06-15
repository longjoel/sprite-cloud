"use client";

import { useState } from "react";

// ── Types ──────────────────────────────────────────────────────────────

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

  async function importToLibrary() {
    if (!results) return;
    setImporting(true);
    setError(null);
    try {
      const files = results.map((r) => ({
        name: overrides[r.file.relative_path] ?? r.match?.name ?? r.file.file_name,
        platform: r.file.platform ?? "Unknown",
        rom_path: r.file.relative_path,
        file_name: r.file.file_name,
        file_size: r.file.file_size,
      }));
      const resp = await fetch("/api/library/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  return (
    <main style={S.main}>
      <h1 style={S.h1}>{serverName || serverId.slice(0, 8)}</h1>

      {error && <div style={S.error}>{error}</div>}

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
                <button
                  style={S.btn}
                  onClick={() => browse(root)}
                  disabled={browsing}
                >
                  {browsing ? "Browsing..." : "Browse"}
                </button>
                <button
                  style={{ ...S.btn, ...S.btnScan }}
                  onClick={() => {
                    setChecked(new Set([root]));
                    scan();
                  }}
                  disabled={scanning}
                >
                  {scanning ? "Scanning..." : "Scan all"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* File tree */}
      {tree && !results && (
        <section style={S.section}>
          <h2 style={S.h2}>Files</h2>
          <TreeView node={tree} checked={checked} onToggle={toggle} />
          {checked.size > 0 && (
            <button
              style={{ ...S.btn, ...S.btnScan, marginTop: 12 }}
              onClick={scan}
              disabled={scanning}
            >
              {scanning ? "Scanning..." : `Scan selected (${checked.size})`}
            </button>
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
              {results.map((r, i) => {
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
                      <input
                        style={S.input}
                        value={name}
                        onChange={(e) =>
                          setOverrides((prev) => ({
                            ...prev,
                            [key]: e.target.value,
                          }))
                        }
                      />
                    </td>
                    <td style={S.td}>
                      {r.match ? (
                        <span style={S.matchBadge}>✓ DAT</span>
                      ) : (
                        <span style={S.noMatch}>manual</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <button
            style={{ ...S.btn, ...S.btnAdd, marginTop: 12 }}
            onClick={importToLibrary}
            disabled={added || importing}
          >
            {importing ? "Importing..." : added ? "✓ Added" : "Add to library"}
          </button>
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
            color: node.type === "error" ? "#e55" : undefined,
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

async function enqueueCommand(
  serverId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const resp = await fetch("/api/server/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  for (let i = 0; i < maxTries; i++) {
    await new Promise((r) => setTimeout(r, 1000));

    const resp = await fetch(`/api/commands/${commandId}/result`);
    if (resp.status === 404) continue;
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    if (data.result !== null && data.result !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return data.result as any;
    }
  }
  throw new Error("Timed out waiting for server response.");
}

// ── Styles ─────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  main: {
    padding: "2rem",
    fontFamily: "monospace",
    background: "#111",
    color: "#ccc",
    minHeight: "100vh",
  },
  h1: { margin: "0 0 2rem", fontSize: "1.5rem", color: "#fff" },
  h2: { margin: "0 0 1rem", fontSize: "1rem", color: "#aaa" },
  section: { marginBottom: "2rem" },
  empty: { fontSize: 13, color: "#666", fontStyle: "italic" },
  error: {
    padding: "8px 12px",
    background: "rgba(255,80,80,0.15)",
    border: "1px solid rgba(255,80,80,0.3)",
    borderRadius: 4,
    marginBottom: "1rem",
    fontSize: 13,
    color: "#e55",
  },
  rootList: { listStyle: "none", padding: 0, margin: 0 },
  rootItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 0",
    borderBottom: "1px solid #222",
  },
  path: { fontSize: 13, color: "#6af", flex: 1 },
  btn: {
    padding: "4px 14px",
    border: "1px solid #444",
    background: "#222",
    color: "#ccc",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 12,
    borderRadius: 3,
  },
  btnScan: { borderColor: "#6af", color: "#6af" },
  btnAdd: { borderColor: "#2a2", color: "#2a2" },
  treeRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 0",
    cursor: "pointer",
    fontSize: 13,
  },
  treeIcon: { fontSize: 13 },
  treeName: { fontSize: 13 },
  checkbox: { width: 16, fontSize: 12, color: "#888" },
  table: { width: "100%", borderCollapse: "collapse" as const },
  th: {
    textAlign: "left" as const,
    padding: "6px 12px",
    borderBottom: "1px solid #333",
    fontSize: 12,
    color: "#888",
  },
  td: {
    padding: "6px 12px",
    borderBottom: "1px solid #222",
    fontSize: 13,
  },
  input: {
    padding: "2px 6px",
    border: "1px solid #444",
    background: "#1a1a1a",
    color: "#ccc",
    fontFamily: "monospace",
    fontSize: 13,
    borderRadius: 3,
    width: "100%",
  },
  fileName: { fontSize: 12, color: "#6af" },
  matchBadge: { fontSize: 11, color: "#2a2" },
  noMatch: { fontSize: 11, color: "#888", fontStyle: "italic" },
  note: { fontSize: 13, color: "#2a2", marginTop: 8 },
  link: { color: "#6af", textDecoration: "none", fontSize: 13 },
};
