import { NextResponse } from "next/server";
import { and, count, eq, inArray } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { ACTIVE_SESSION_STATES, STATUS_LEASED, STATUS_PENDING } from "@/lib/constants";
import { db } from "@/lib/db";
import { commands, serverGames, serverMembers, servers, sessions } from "@/lib/db/schema";

const CMD_UPGRADE_SERVER = "upgrade_server";
const ONLINE_THRESHOLD_MS = 90 * 1000;
const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;

type ServerHealth = "online" | "idle" | "offline";

type ServerMetadata = {
  version?: unknown;
  lan?: {
    health_urls?: unknown;
  };
};

type RuntimeTelemetry = {
  cpuPercent: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  memoryUsedBytes: number;
  memoryUsedPercent: number;
  uptimeSeconds: number;
  activeSessionCount: number;
};

type RuntimeStatus = "healthy" | "pressure" | "connected" | "stale";

type RuntimeSummary = {
  status: RuntimeStatus;
  pressure: "normal" | "elevated" | "critical" | "unknown";
  telemetry: RuntimeTelemetry | null;
};

function runtimeSummary(lastSeenAt: Date | string | null, value: unknown, now = Date.now()): RuntimeSummary {
  const age = lastSeenAt ? now - new Date(lastSeenAt).getTime() : Number.POSITIVE_INFINITY;
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const numbers = [
    raw.cpu_percent,
    raw.memory_total_bytes,
    raw.memory_available_bytes,
    raw.memory_used_bytes,
    raw.memory_used_percent,
    raw.uptime_seconds,
    raw.active_session_count,
  ];
  const valid = numbers.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0);
  if (!valid) return { status: age >= OFFLINE_THRESHOLD_MS ? "stale" : "connected", pressure: "unknown", telemetry: null };

  const telemetry: RuntimeTelemetry = {
    cpuPercent: raw.cpu_percent as number,
    memoryTotalBytes: raw.memory_total_bytes as number,
    memoryAvailableBytes: raw.memory_available_bytes as number,
    memoryUsedBytes: raw.memory_used_bytes as number,
    memoryUsedPercent: raw.memory_used_percent as number,
    uptimeSeconds: raw.uptime_seconds as number,
    activeSessionCount: raw.active_session_count as number,
  };
  const peak = Math.max(telemetry.cpuPercent, telemetry.memoryUsedPercent);
  const pressure = peak >= 90 ? "critical" : peak >= 75 ? "elevated" : "normal";
  return {
    status: age >= OFFLINE_THRESHOLD_MS ? "stale" : pressure === "normal" ? "healthy" : "pressure",
    pressure,
    telemetry,
  };
}

function serverHealth(lastSeenAt: Date | string | null, now = Date.now()): ServerHealth {
  if (!lastSeenAt) return "offline";
  const timestamp = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(timestamp)) return "offline";
  const age = now - timestamp;
  if (age < ONLINE_THRESHOLD_MS) return "online";
  if (age < OFFLINE_THRESHOLD_MS) return "idle";
  return "offline";
}

function metadataSummary(metadata: unknown) {
  const value = metadata && typeof metadata === "object" ? metadata as ServerMetadata : {};
  const healthUrls = Array.isArray(value.lan?.health_urls)
    ? value.lan.health_urls.filter((url): url is string => typeof url === "string")
    : [];

  return {
    installedVersion: typeof value.version === "string" ? value.version : null,
    lan: {
      configured: healthUrls.length > 0,
      healthUrls,
    },
  };
}

/** Return operational summaries for servers visible to the signed-in user. */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const memberships = await db
    .select({
      serverId: servers.id,
      role: serverMembers.role,
      lastSeenAt: servers.lastSeenAt,
      runtimeTelemetry: servers.runtimeTelemetry,
      metadata: servers.metadata,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(eq(serverMembers.userId, session.user.id));

  if (memberships.length === 0) {
    return NextResponse.json({ servers: [] });
  }

  const serverIds = memberships.map(({ serverId }) => serverId);
  const gameCounts = await db
    .select({ serverId: serverGames.serverId, count: count() })
    .from(serverGames)
    .where(inArray(serverGames.serverId, serverIds))
    .groupBy(serverGames.serverId);
  const activeSessionCounts = await db
    .select({ serverId: sessions.serverId, count: count() })
    .from(sessions)
    .where(and(
      inArray(sessions.serverId, serverIds),
      inArray(sessions.status, [...ACTIVE_SESSION_STATES]),
    ))
    .groupBy(sessions.serverId);
  const activeUpgrades = await db
    .select({ serverId: commands.serverId, commandId: commands.id, status: commands.status })
    .from(commands)
    .where(and(
      inArray(commands.serverId, serverIds),
      eq(commands.type, CMD_UPGRADE_SERVER),
      inArray(commands.status, [STATUS_PENDING, STATUS_LEASED]),
    ));

  const gameCountByServer = new Map(gameCounts.map((row) => [row.serverId, Number(row.count)]));
  const sessionCountByServer = new Map(activeSessionCounts.map((row) => [row.serverId, Number(row.count)]));
  const upgradeByServer = new Map(activeUpgrades.map((row) => [row.serverId, {
    commandId: row.commandId,
    status: row.status,
  }]));

  return NextResponse.json({
    servers: memberships.map((membership) => {
      const metadata = metadataSummary(membership.metadata);
      return {
        serverId: membership.serverId,
        role: membership.role,
        health: serverHealth(membership.lastSeenAt),
        runtime: runtimeSummary(membership.lastSeenAt, membership.runtimeTelemetry),
        lastSeenAt: membership.lastSeenAt
          ? new Date(membership.lastSeenAt).toISOString()
          : null,
        installedVersion: metadata.installedVersion,
        activeSessionCount: sessionCountByServer.get(membership.serverId) ?? 0,
        gameCount: gameCountByServer.get(membership.serverId) ?? 0,
        lan: metadata.lan,
        activeUpgrade: membership.role === "admin"
          ? upgradeByServer.get(membership.serverId) ?? null
          : null,
      };
    }),
  });
}
