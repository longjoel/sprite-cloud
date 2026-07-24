import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { gameFiles, servers, serverMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

const STALE_THRESHOLD_MS = 90_000;   // 90s without a poll → stale
const OFFLINE_THRESHOLD_MS = 300_000; // 5 min without a poll → offline

function classifyStatus(lastSeenAt: Date | string | null): string {
  if (!lastSeenAt) return "offline";
  const ms = Date.now() - new Date(lastSeenAt).getTime();
  if (ms < STALE_THRESHOLD_MS) return "online";
  if (ms < OFFLINE_THRESHOLD_MS) return "stale";
  return "offline";
}

interface LanSummary {
  player_port?: number;
  player_urls?: string[];
  health_urls?: string[];
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return (metadata || {}) as Record<string, unknown>;
}

function lanSummary(metadata: unknown): LanSummary | null {
  const lan = metadataRecord(metadata).lan as LanSummary | undefined;
  if (!lan || typeof lan !== "object") return null;
  return {
    player_port: typeof lan.player_port === "number" ? lan.player_port : undefined,
    player_urls: Array.isArray(lan.player_urls) ? lan.player_urls.filter((url): url is string => typeof url === "string") : [],
    health_urls: Array.isArray(lan.health_urls) ? lan.health_urls.filter((url): url is string => typeof url === "string") : [],
  };
}

function classifyServerCapabilities(metadata: unknown): { lan: boolean; stun: boolean; turn: boolean } {
  const meta = metadataRecord(metadata);
  const lan = lanSummary(metadata);
  const ice = meta.ice as Record<string, unknown> | undefined;
  const ifaces = meta.interfaces;

  const hasLan = !!(lan?.health_urls?.length || lan?.player_urls?.length || (Array.isArray(ifaces) && ifaces.length > 0));
  const hasTurn = !!(ice?.turn_configured);
  const hasStun = !!ice || hasTurn;

  return { lan: hasLan, stun: hasStun, turn: hasTurn };
}

// GET /api/playable-hosts?game_id=...
// Returns all servers the user is a member of, with game availability,
// online status, and route hints. No secrets exposed.
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const gameId = request.nextUrl.searchParams.get("game_id");
  if (!gameId) {
    return NextResponse.json({ error: "game_id required" }, { status: 400 });
  }

  const rows = await db
    .select({
      serverId: servers.id,
      serverName: servers.name,
      lastSeenAt: servers.lastSeenAt,
      metadata: servers.metadata,
      gameFileId: gameFiles.id,
      role: serverMembers.role,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .leftJoin(
      gameFiles,
      and(eq(gameFiles.serverId, servers.id), eq(gameFiles.gameId, gameId)),
    )
    .where(eq(serverMembers.userId, session.user.id));

  const hosts = rows.map((row) => ({
    server_id: row.serverId,
    name: row.serverName,
    status: classifyStatus(row.lastSeenAt),
    has_game: row.gameFileId !== null,
    capabilities: classifyServerCapabilities(row.metadata),
    lan: lanSummary(row.metadata),
    role: row.role,
    metadata: row.metadata ?? {},
  }));

  return NextResponse.json({ hosts });
}
