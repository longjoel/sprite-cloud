"use client";

import { useState, useEffect } from "react";
import { pollUntil } from "@/lib/poll";
import { Badge, Button } from "@/components/ui";

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
  interfaces: Array<{ name: string; address: string }>;
  public_ip?: string;
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
  runtime?: {
    pc_pool_size: number;
    video_scale_height: number;
    video_max_scale: number;
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
  romRoots: string[];
}

// ── Component ──────────────────────────────────────────────────────────

export default function ServerPanel({ serverId, romRoots }: Props) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [browsing, setBrowsing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<ScanResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [metadata, setMetadata] = useState<ServerMetadata | null>(null);
  const [coreOverrides, setCoreOverrides] = useState<Record<string, string>>({});
  const [availableCores, setAvailableCores] = useState<string[]>([]);

  useEffect(() => {
    fetch(`/api/servers/${serverId}/metadata`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.metadata) setMetadata(d.metadata);
      })
      .catch(() => {});
  }, [serverId]);

  useEffect(() => {
    fetch(`/api/servers/${serverId}/core-overrides`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.overrides) setCoreOverrides(d.overrides);
      })
      .catch(() => {});
  }, [serverId]);

  async function setCore(platform: string, core: string) {
    const newOverrides = { ...coreOverrides, [platform]: core };
    setCoreOverrides(newOverrides);
    try {
      await fetch(`/api/servers/${serverId}/core-overrides`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: newOverrides }),
      });
    } catch (e) {
      console.error("Failed to save core override:", e);
    }
  }

  // Known platforms and their default cores (sync with platform.rs)
  const platformCores: Array<{ platform: string; defaultCore: string }> = [
    { platform: "Game Boy", defaultCore: "gambatte_libretro.so" },
    { platform: "Game Boy Color", defaultCore: "gambatte_libretro.so" },
    { platform: "Game Boy Advance", defaultCore: "mgba_libretro.so" },
    { platform: "NES", defaultCore: "nestopia_libretro.so" },
    { platform: "SNES", defaultCore: "snes9x_libretro.so" },
    { platform: "Genesis", defaultCore: "genesis_plus_gx_libretro.so" },
    { platform: "Atari 2600", defaultCore: "stella2014_libretro.so" },
  ];

  // Common core options
  const coreOptions: Array<{ value: string; label: string }> = [
    { value: "gambatte_libretro.so", label: "Gambatte" },
    { value: "sameboy_libretro.so", label: "SameBoy" },
    { value: "mgba_libretro.so", label: "mGBA" },
    { value: "nestopia_libretro.so", label: "Nestopia" },
    { value: "fceumm_libretro.so", label: "FCEUmm" },
    { value: "snes9x_libretro.so", label: "Snes9x" },
    { value: "genesis_plus_gx_libretro.so", label: "Genesis Plus GX" },
    { value: "stella2014_libretro.so", label: "Stella 2014" },
    { value: "stella_libretro.so", label: "Stella (latest)" },
  ];

  async function browse(path: string) {
    setBrowsing(true);
    setError(null);
    setTree(null);
    try {
      const cmd = await enqueueCommand(serverId, "browse_files", { path });
      const result = await pollResult(cmd.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = result as any;
      const tree = r?.tree as TreeNode | undefined;
      const errMsg = r?.error as string | undefined;
      if (tree) {
        setTree(tree);
      } else if (errMsg) {
        setError(errMsg);
      } else {
        setError("Unexpected response from server.");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Browse failed.");
    } finally {
      setBrowsing(false);
    }
  }

  async function scan(pathsOverride?: string[]) {
    const paths = pathsOverride ?? Array.from(checked);
    if (paths.length === 0) return;
    setScanning(true);
    setError(null);
    setResults(null);
    setAdded(false);
    try {
      const cmd = await enqueueCommand(serverId, "scan_paths", { paths });
      const result = await pollResult(cmd.id, 120);
      const r = result as any;
      const imported = r?.imported as number | undefined;
      const importErr = r?.import_error as string | undefined;
      const matches = r?.matches as ScanResult[] | undefined;
      if (imported !== undefined) {
        setAdded(true);
        setError(`${imported} games imported to library.`);
      } else if (importErr) {
        setError(`Import failed: ${importErr}`);
      } else if (matches) {
        setResults(matches);
      } else {
        const err = r?.error as string | undefined;
        setError(err || "Scan complete — no files found.");
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

  return (
    <div>
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
                  onClick={() => scan([root])}
                  disabled={scanning}
                >
                  {scanning ? "Scanning..." : "Scan all"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* File tree — directories only with file counts */}
      {tree && !results && (
        <section style={S.section}>
          <h2 style={S.h2}>Files</h2>
          <DirList tree={tree} checked={checked} onToggle={toggle} />
          {checked.size > 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => scan()}
              disabled={scanning}
              style={{ marginTop: "var(--space-5)" }}
            >
              {scanning
                ? "Scanning..."
                : `Scan selected (${checked.size})`}
            </Button>
          )}
        </section>
      )}

      {/* Scan results (server auto-imported) */}
      {results && (
        <section style={S.section}>
          <h2 style={S.h2}>Results ({results.length} files)</h2>
          {added && (
            <p style={S.note}>
              <a href="/" style={S.link}>View library →</a>
            </p>
          )}
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>File</th>
                <th style={S.th}>Platform</th>
                <th style={S.th}>DAT match</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const key = r.file.relative_path;
                return (
                  <tr key={key}>
                    <td style={S.td}>
                      <code style={S.fileName}>{r.file.file_name}</code>
                    </td>
                    <td style={S.td}>{r.file.platform ?? "—"}</td>
                    <td style={S.td}>
                      {r.match ? (
                        <Badge variant="success">{r.match.game_name || r.match.name}</Badge>
                      ) : (
                        <span style={S.noMatch}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* Connectivity */}
      {metadata && (
        <section style={S.section}>
          <h2 style={S.h2}>Server</h2>
          <table style={S.metaTable}>
            <tbody>
              <MetadataRow label="Version" value={metadata.version} />
              <MetadataRow
                label="Interfaces"
                value={
                  metadata.interfaces?.length
                    ? metadata.interfaces
                        .map((i) => `${i.name}: ${i.address}`)
                        .join(", ")
                    : "—"
                }
              />
              <MetadataRow
                label="Public IP"
                value={metadata.public_ip || "—"}
                muted={!metadata.public_ip}
              />
              <MetadataRow
                label="STUN"
                value={
                  metadata.ice?.stun_urls?.length
                    ? metadata.ice.stun_urls.join(", ")
                    : "not configured"
                }
                muted={!metadata.ice?.stun_urls?.length}
              />
              <MetadataRow
                label="TURN"
                value={
                  metadata.ice?.turn_configured
                    ? metadata.ice?.turn_urls?.join(", ") || "—"
                    : "not configured"
                }
                muted={!metadata.ice?.turn_configured}
              />
              <MetadataRow
                label="ICE policy"
                value={metadata.ice?.transport_policy || "—"}
              />
            </tbody>
          </table>
        </section>
      )}

      {/* Component versions */}
      {metadata?.versions &&
        (metadata.versions.server ||
          metadata.versions.worker ||
          metadata.versions.runner) && (
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
                {(
                  [
                    ["server", metadata.versions.server],
                    ["worker", metadata.versions.worker],
                    ["runner", metadata.versions.runner],
                  ] as const
                )
                  .filter(([, version]) => Boolean(version))
                  .map(([component, version]) => (
                    <tr key={component}>
                      <td style={S.td}>{component}</td>
                      <td style={S.td}>
                        <code style={S.fileName}>
                          {version?.package_version ?? "—"}
                        </code>
                      </td>
                      <td style={S.td}>
                        <code style={S.fileName}>
                          {version?.git_sha?.slice(0, 7) ?? "—"}
                        </code>
                      </td>
                      <td style={S.td}>
                        {version?.built_at_utc ??
                          version?.released_at_utc ??
                          "—"}
                      </td>
                      <td style={S.td}>
                        {version?.binary_path ? (
                          <code style={S.fileName}>
                            {version.binary_path}
                          </code>
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

      {/* Runtime config */}
      {metadata?.runtime && (
        <section style={S.section}>
          <h2 style={S.h2}>Runtime</h2>
          <table style={S.metaTable}>
            <tbody>
              <MetadataRow label="Worker pool" value={String(metadata.runtime.pc_pool_size)} />
              <MetadataRow label="Scale height" value={String(metadata.runtime.video_scale_height)} />
              <MetadataRow label="Max scale" value={String(metadata.runtime.video_max_scale)} />
            </tbody>
          </table>
        </section>
      )}

      {/* Cores — per-platform overrides */}
      <section style={S.section}>
        <h2 style={S.h2}>Cores</h2>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Platform</th>
              <th style={S.th}>Core</th>
              <th style={S.th}>Override</th>
            </tr>
          </thead>
          <tbody>
            {platformCores.map((pc) => {
              const current = coreOverrides[pc.platform] || pc.defaultCore;
              const isOverridden = coreOverrides[pc.platform] !== undefined;
              return (
                <tr key={pc.platform}>
                  <td style={S.td}>{pc.platform}</td>
                  <td style={S.td}>
                    <code style={{ ...S.fileName, color: isOverridden ? "var(--color-info)" : undefined }}>
                      {current}
                    </code>
                  </td>
                  <td style={S.td}>
                    <select
                      value={current}
                      onChange={(e) => setCore(pc.platform, e.target.value)}
                      style={S.coreSelect}
                    >
                      {coreOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p style={S.note}>
          Changes take effect on the next game launch. Server uses defaults until overridden.
        </p>
      </section>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function MetadataRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <tr>
      <td style={S.metaLabel}>{label}</td>
      <td style={{ ...S.metaValue, color: muted ? "var(--color-muted)" : undefined }}>{value}</td>
    </tr>
  );
}

/** Count file nodes recursively. */
function countFiles(node: TreeNode): number {
  if (node.type === "file") return 1;
  if (!node.children) return 0;
  return node.children.reduce((sum, child) => sum + countFiles(child), 0);
}

/** Flat list of directories with file counts — no raw file entries. */
function DirList({
  tree,
  checked,
  onToggle,
}: {
  tree: TreeNode;
  checked: Set<string>;
  onToggle: (path: string) => void;
}) {
  // Build a flat list of dirs with their full path and file count.
  const entries: Array<{ path: string; name: string; fileCount: number }> = [];

  function walk(node: TreeNode, parentPath: string) {
    if (node.type !== "dir") return;
    const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name;
    const fileCount = countFiles(node);
    entries.push({ path: fullPath, name: node.name, fileCount });

    if (node.children) {
      for (const child of node.children) {
        walk(child, fullPath);
      }
    }
  }

  walk(tree, tree.name || "");

  if (entries.length === 0) {
    return <p style={S.empty}>No directories found.</p>;
  }

  return (
    <div style={{ maxHeight: 400, overflowY: "auto" }}>
      {entries.map((entry) => (
        <div
          key={entry.path}
          style={{
            ...S.dirRow,
            background: checked.has(entry.path)
              ? "rgba(56,189,248,0.08)"
              : "transparent",
          }}
          onClick={() => onToggle(entry.path)}
        >
          <span style={S.checkbox}>
            {checked.has(entry.path) ? "☑" : "☐"}
          </span>
          <span style={S.treeIcon}>📁</span>
          <span style={{ ...S.treeName, flex: 1 }}>{entry.name}</span>
          <span style={S.fileCount}>
            {entry.fileCount} file{entry.fileCount !== 1 ? "s" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── API helpers ────────────────────────────────────────────────────────

function csrfHeaders(): Record<string, string> {
  let token = document.cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("sc_csrf_token="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!token) {
    token = crypto.randomUUID();
    document.cookie = `sc_csrf_token=${encodeURIComponent(
      token,
    )}; Path=/; SameSite=Lax`;
  }
  return {
    "Content-Type": "application/json",
    "x-csrf-token": decodeURIComponent(token),
  };
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
): Promise<Record<string, unknown> | null> {
  return pollUntil(
    async () => {
      const resp = await fetch(`/api/commands/${commandId}/result`);
      if (resp.status === 404) return null;
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      return data.result !== null && data.result !== undefined
        ? (data.result as Record<string, unknown>)
        : null;
    },
    { intervalMs: 1000, maxAttempts: maxTries },
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
    borderBottom: "1px solid var(--color-sky-high)",
  },
  path: {
    fontSize: "var(--font-size-base)",
    color: "var(--color-info)",
    flex: 1,
  },
  dirRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "6px 8px",
    cursor: "pointer",
    fontSize: "var(--font-size-base)",
    borderRadius: "2px",
    transition: "background 0.1s",
  },
  treeIcon: { fontSize: "var(--font-size-base)" },
  treeName: { fontSize: "var(--font-size-base)", color: "var(--color-cloud)" },
  fileCount: {
    fontSize: "var(--font-size-xs)",
    color: "var(--color-cloud-dim)",
    fontFamily: "var(--font-mono)",
    whiteSpace: "nowrap",
  },
  checkbox: {
    width: 16,
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
  },
  table: { width: "100%", borderCollapse: "collapse" as const },
  th: {
    textAlign: "left" as const,
    padding: "var(--space-3) var(--space-5)",
    borderBottom: "1px solid var(--color-sky-high)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  td: {
    padding: "var(--space-3) var(--space-5)",
    borderBottom: "1px solid var(--color-sky-high)",
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
  metaTable: {
    borderCollapse: "collapse" as const,
    fontSize: "var(--font-size-base)",
  },
  metaLabel: {
    padding: "2px var(--space-6) 2px 0",
    color: "var(--color-muted)",
    textAlign: "right" as const,
    whiteSpace: "nowrap" as const,
  },
  metaValue: {
    padding: "2px 0",
    color: "var(--color-cloud)",
    wordBreak: "break-all" as const,
  },
  coreSelect: {
    background: "var(--color-sky-mid)",
    color: "var(--color-cloud)",
    border: "1px solid var(--color-sky-high)",
    borderRadius: "var(--radius-sm)",
    padding: "2px 6px",
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-mono)",
    cursor: "pointer",
  },
};
