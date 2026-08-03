import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { servers, sessions } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { readFileSync } from "fs";
import { join } from "path";
import { getConnectivityDiagnostic, type ConnectivityDiagnostic } from "@/lib/connectivity-diagnostic";
import { runTurnProbe } from "@/lib/turn-probe";

interface VersionInfo {
  package_version: string;
  git_sha?: string;
  artifact_sha256?: string;
  built_at_utc?: string;
  released_at_utc?: string;
  binary_path?: string;
}

interface VersionSnapshot {
  web: VersionInfo;
  server: VersionInfo | null;
  worker: VersionInfo | null;
  runner: VersionInfo | null;
  source_server: {
    id: string;
    name?: string;
    last_seen_at?: string;
  } | null;
}

// ── Types ─────────────────────────────────────────────────────────────

interface ComponentStatus {
  status: "ok" | "degraded" | "error";
  detail?: string;
}

interface HealthResponse {
  status: "ok" | "degraded" | "error";
  phase4c_library_owner: "sc-server";
  components: {
    db: ComponentStatus;
    api_routes: ComponentStatus;
    sc_server: ComponentStatus;
    schema: ComponentStatus;
    turn: ComponentStatus;
  };
  connectivity: ConnectivityDiagnostic;
  versions: VersionSnapshot;
  timestamp: string;
}

// ── Version reporting ───────────────────────────────────────────────────

// Overridable for tests; defaults to the stamped runtime metadata written
// by the Docker build (see docker/sc-web/Dockerfile.prod + .ci).
function runtimeVersionPath(): string {
  return (
    process.env.GV_RUNTIME_VERSION_PATH ||
    join(process.cwd(), ".next/runtime-version.json")
  );
}

interface RuntimeVersion {
  git_sha?: string;
  git_short_sha?: string;
  git_branch?: string;
  built_at_utc?: string;
  package_version?: string;
}

function readRuntimeVersion(): RuntimeVersion | null {
  try {
    const raw = readFileSync(runtimeVersionPath(), "utf-8");
    return JSON.parse(raw) as RuntimeVersion;
  } catch {
    return null;
  }
}

function getWebVersion(): VersionInfo {
  // Prefer the stamped runtime-version.json (set by deploy-sc-web.sh) over env vars.
  // Env vars are only set when rebuilding the Docker image; runtime-version.json
  // survives tar-based deploys.
  const runtime = readRuntimeVersion();
  if (runtime) {
    return {
      package_version: runtime.package_version || process.env.GV_WEB_VERSION || "unknown",
      git_sha: runtime.git_sha || process.env.GV_WEB_GIT_SHA || undefined,
      released_at_utc: runtime.built_at_utc || process.env.GV_WEB_RELEASED_AT_UTC || undefined,
    };
  }

  return {
    package_version: process.env.GV_WEB_VERSION || "unknown",
    git_sha: process.env.GV_WEB_GIT_SHA || undefined,
    released_at_utc: process.env.GV_WEB_RELEASED_AT_UTC || undefined,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readVersionInfo(value: unknown): VersionInfo | null {
  const obj = asObject(value);
  if (!obj || typeof obj.package_version !== "string") return null;
  return {
    package_version: obj.package_version,
    git_sha: typeof obj.git_sha === "string" ? obj.git_sha : undefined,
    artifact_sha256: typeof obj.artifact_sha256 === "string" ? obj.artifact_sha256 : undefined,
    built_at_utc: typeof obj.built_at_utc === "string" ? obj.built_at_utc : undefined,
    released_at_utc: typeof obj.released_at_utc === "string" ? obj.released_at_utc : undefined,
    binary_path: typeof obj.binary_path === "string" ? obj.binary_path : undefined,
  };
}

async function loadVersionSnapshot(): Promise<VersionSnapshot> {
  const web = getWebVersion();

  try {
    const recent = await db
      .select({
        id: servers.id,
        name: servers.name,
        lastSeenAt: servers.lastSeenAt,
        metadata: servers.metadata,
      })
      .from(servers)
      .orderBy(desc(servers.lastSeenAt))
      .limit(1);

    if (recent.length === 0) {
      return { web, server: null, worker: null, runner: null, source_server: null };
    }

    const latest = recent[0];
    const meta = asObject(latest.metadata);
    const versions = asObject(meta?.versions);

    return {
      web,
      server: readVersionInfo(versions?.server),
      worker: readVersionInfo(versions?.worker),
      runner: readVersionInfo(versions?.runner),
      source_server: {
        id: latest.id,
        name: latest.name ?? undefined,
        last_seen_at: latest.lastSeenAt ? latest.lastSeenAt.toISOString() : undefined,
      },
    };
  } catch {
    return { web, server: null, worker: null, runner: null, source_server: null };
  }
}

// ── Checks ────────────────────────────────────────────────────────────

async function checkDb(): Promise<ComponentStatus> {
  try {
    await db.execute(sql`SELECT 1`);
    return { status: "ok" };
  } catch (e) {
    return { status: "error", detail: String(e) };
  }
}

async function checkApiRoutes(): Promise<ComponentStatus> {
  try {
    // Verify the sessions table is queryable — proves schema was applied.
    await db.select().from(sessions).limit(1);
    return { status: "ok" };
  } catch (e) {
    return {
      status: "error",
      detail: `sessions table not queryable — schema may not be applied: ${String(e)}`,
    };
  }
}

async function checkScServer(): Promise<ComponentStatus> {
  try {
    // Check if any server has polled within the last 60 seconds.
    const recent = await db
      .select({ id: servers.id, lastSeenAt: servers.lastSeenAt })
      .from(servers)
      .orderBy(desc(servers.lastSeenAt))
      .limit(1);

    if (recent.length === 0) {
      return { status: "degraded", detail: "No servers paired" };
    }

    const lastSeen = recent[0].lastSeenAt;
    if (!lastSeen) {
      return { status: "degraded", detail: "Server has never polled" };
    }

    const ageSecs = (Date.now() - lastSeen.getTime()) / 1000;
    if (ageSecs > 60) {
      return {
        status: "degraded",
        detail: `Last poll ${Math.round(ageSecs)}s ago`,
      };
    }

    return { status: "ok" };
  } catch (e) {
    return { status: "error", detail: String(e) };
  }
}

async function checkSchema(): Promise<ComponentStatus> {
  try {
    // Verify sessions table has critical columns by querying them.
    // If a column is missing (migration not applied), the query throws.
    await db
      .select({
        id: sessions.id,
        roomToken: sessions.roomToken,
        maxSeats: sessions.maxSeats,
        sdpAnswer: sessions.sdpAnswer,
      })
      .from(sessions)
      .limit(1);

    return { status: "ok" };
  } catch (e) {
    const msg = String(e);
    if (msg.includes("does not exist") || msg.includes("column")) {
      return {
        status: "error",
        detail: "Missing columns — run drizzle-kit push",
      };
    }
    return { status: "error", detail: msg };
  }
}

// ── Aggregation ───────────────────────────────────────────────────────

function overallStatus(
  components: HealthResponse["components"]
): "ok" | "degraded" | "error" {
  const statuses = Object.values(components).map((c) => c.status);
  if (statuses.includes("error")) return "error";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

// ── Turn probe component ──────────────────────────────────────────────

function turnComponent(connectivity: ConnectivityDiagnostic): ComponentStatus {
  if (!connectivity.turn_configured) {
    return { status: "ok", detail: "TURN not configured — LAN/friendly-NAT mode" };
  }
  switch (connectivity.turn_state) {
    case "relayed":
      return { status: "ok", detail: "TURN relay allocation verified by live probe" };
    case "credential-issued":
      return {
        status: "degraded",
        detail: "TURN listener reachable and credential mechanism active, but relay allocation not yet proven",
      };
    case "configured":
      return { status: "degraded", detail: "TURN configured; probe pending" };
    default:
      return {
        status: "error",
        detail: connectivity.probe?.error || "TURN relay probe failed",
      };
  }
}

// ── Route ─────────────────────────────────────────────────────────────

// GET /api/health — deep stack health check (no auth required)
export async function GET() {
  const components: HealthResponse["components"] = {
    db: await checkDb(),
    api_routes: await checkApiRoutes(),
    sc_server: await checkScServer(),
    schema: await checkSchema(),
    turn: { status: "ok", detail: "pending probe" },
  };

  // Probe the production TURN path. The probe is cached (60s success / 15s
  // failure TTL) so health stays fast and flapping relays are detected
  // promptly. Failures fail closed: components.turn becomes error.
  // When no TURN URL is configured there is nothing to probe.
  let probe = null;
  const turnUrls = (process.env.GV_ICE_TURN_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (turnUrls.length > 0) {
    try {
      probe = await runTurnProbe();
    } catch (e) {
      probe = {
        state: "failed" as const,
        probed_at: new Date().toISOString(),
        error: String(e),
      };
    }
  }
  const connectivity = getConnectivityDiagnostic(probe);
  components.turn = turnComponent(connectivity);

  const status = overallStatus(components);
  const versions = await loadVersionSnapshot();

  const body: HealthResponse = {
    status,
    phase4c_library_owner: "sc-server",
    components,
    connectivity,
    versions,
    timestamp: new Date().toISOString(),
  };

  const httpStatus =
    status === "error" ? 503 : status === "degraded" ? 200 : 200;

  return NextResponse.json(body, { status: httpStatus });
}
