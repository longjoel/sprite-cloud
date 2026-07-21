// ── Dashboard version types and helpers ─────────────────────────────────

export interface ComponentVersion {
  package_version: string;
  git_sha?: string;
  artifact_sha256?: string;
  built_at_utc?: string;
  released_at_utc?: string;
  binary_path?: string;
}

export interface VersionMetadata {
  server?: ComponentVersion;
  worker?: ComponentVersion;
  runner?: ComponentVersion;
}

export interface ServerMetadata {
  version?: string;
  versions?: VersionMetadata;
  rom_roots?: string[];
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readComponentVersion(value: unknown): ComponentVersion | null {
  const obj = asObject(value);
  if (!obj || typeof obj.package_version !== "string") return null;
  return {
    package_version: obj.package_version,
    git_sha: typeof obj.git_sha === "string" ? obj.git_sha : undefined,
    artifact_sha256:
      typeof obj.artifact_sha256 === "string" ? obj.artifact_sha256 : undefined,
    built_at_utc: typeof obj.built_at_utc === "string" ? obj.built_at_utc : undefined,
    released_at_utc:
      typeof obj.released_at_utc === "string" ? obj.released_at_utc : undefined,
    binary_path: typeof obj.binary_path === "string" ? obj.binary_path : undefined,
  };
}

export function readServerMetadata(value: unknown): ServerMetadata {
  const obj = asObject(value);
  if (!obj) return {};
  const versions = asObject(obj.versions);
  return {
    version: typeof obj.version === "string" ? obj.version : undefined,
    rom_roots: Array.isArray(obj.rom_roots)
      ? obj.rom_roots.filter((x): x is string => typeof x === "string")
      : undefined,
    versions: versions
      ? {
          server: readComponentVersion(versions.server) ?? undefined,
          worker: readComponentVersion(versions.worker) ?? undefined,
          runner: readComponentVersion(versions.runner) ?? undefined,
        }
      : undefined,
  };
}

export function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 7) : "—";
}

export function formatTimestamp(ts?: string): string {
  if (!ts) return "—";
  return ts.replace("T", " ").replace("Z", " UTC");
}

export function webVersion(): ComponentVersion {
  return {
    package_version: process.env.GV_WEB_VERSION || "unknown",
    git_sha: process.env.GV_WEB_GIT_SHA || undefined,
    released_at_utc: process.env.GV_WEB_RELEASED_AT_UTC || undefined,
  };
}
