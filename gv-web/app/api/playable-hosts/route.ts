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

function classifyRouteHint(metadata: unknown): string {
  const meta = (metadata || {}) as Record<string, unknown>;
  const ice = meta.ice as Record<string, unknown> | undefined;
  const lanAddrs = meta.lan_addresses;

  // Server on the LAN (has LAN addresses) → "local"
  if (Array.isArray(lanAddrs) && lanAddrs.length > 0) return "local";

  // Server with TURN configured → "relay"
  if (ice?.turn_configured) return "relay";

  // Server with STUN but no TURN, no LAN → "direct"
  if (ice) return "direct";

  return "unknown";
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
    route_hint: classifyRouteHint(row.metadata),
    metadata: row.metadata ?? {},
  }));

  return NextResponse.json({ hosts });
}
