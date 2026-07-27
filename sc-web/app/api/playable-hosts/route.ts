import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { servers, serverMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

const STALE_THRESHOLD_MS = 90_000;   // 90s without a poll → stale
const OFFLINE_THRESHOLD_MS = 300_000; // 5 min without a poll → offline

// RFC 1918 private IPv4 ranges
function isPrivateIp(ip: string): boolean {
  // IPv4
  const v4 = ip.split(".").map(Number);
  if (v4.length === 4 && v4.every((o) => !isNaN(o) && o >= 0 && o <= 255)) {
    if (v4[0] === 10) return true;
    if (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) return true;
    if (v4[0] === 192 && v4[1] === 168) return true;
    if (v4[0] === 127) return true; // loopback
  }
  // IPv6: fd00::/8 (unique local)
  if (ip.startsWith("fd") || ip.startsWith("fc")) return true;
  if (ip === "::1") return true; // loopback
  return false;
}

function getClientIp(request: NextRequest): string {
  // Vercel / reverse proxy headers
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    return xff.split(",")[0].trim();
  }
  // Fly / other
  const fly = request.headers.get("fly-client-ip");
  if (fly) return fly.trim();
  // Cloudflare
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  return "127.0.0.1";
}

function classifyStatus(lastSeenAt: Date | string | null): string {
  if (!lastSeenAt) return "offline";
  const ms = Date.now() - new Date(lastSeenAt).getTime();
  if (ms < STALE_THRESHOLD_MS) return "online";
  if (ms < OFFLINE_THRESHOLD_MS) return "stale";
  return "offline";
}

interface LanSummary {
  lan_player_enabled?: boolean;
  player_port?: number;
  player_urls?: string[];
  health_urls?: string[];
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return (metadata || {}) as Record<string, unknown>;
}

function lanSummary(metadata: unknown): LanSummary | null {
  const lan = metadataRecord(metadata).lan as LanSummary | undefined;
  if (!lan || typeof lan !== "object" || lan.lan_player_enabled === false) return null;
  return {
    lan_player_enabled: lan.lan_player_enabled,
    player_port: typeof lan.player_port === "number" ? lan.player_port : undefined,
    player_urls: Array.isArray(lan.player_urls) ? lan.player_urls.filter((url): url is string => typeof url === "string") : [],
    health_urls: Array.isArray(lan.health_urls) ? lan.health_urls.filter((url): url is string => typeof url === "string") : [],
  };
}

function classifyServerCapabilities(metadata: unknown): { lan: boolean; stun: boolean; turn: boolean } {
  const meta = metadataRecord(metadata);
  const lan = lanSummary(metadata);
  const lanMetadata = meta.lan as LanSummary | undefined;
  const ice = meta.ice as Record<string, unknown> | undefined;
  const ifaces = meta.interfaces;

  const hasLan = lanMetadata?.lan_player_enabled === false
    ? false
    : !!(lan?.health_urls?.length || lan?.player_urls?.length || (Array.isArray(ifaces) && ifaces.length > 0));
  const hasTurn = !!(ice?.turn_configured);
  const hasStun = !!ice || hasTurn;

  return { lan: hasLan, stun: hasStun, turn: hasTurn };
}

// GET /api/playable-hosts?game_id=...&server_id=...
// Returns all servers the user is a member of, with game availability,
// online status, and route hints. No secrets exposed.
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const gameId = request.nextUrl.searchParams.get("game_id");
  const requestedServerId = request.nextUrl.searchParams.get("server_id");
  if (!gameId || !requestedServerId || !/^local_[0-9a-f]{32}$/.test(gameId)) {
    return NextResponse.json({ error: "opaque game_id and server_id required" }, { status: 400 });
  }

  const rows = await db
    .select({
      serverId: servers.id,
      serverName: servers.name,
      lastSeenAt: servers.lastSeenAt,
      metadata: servers.metadata,
      role: serverMembers.role,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(
      and(eq(serverMembers.userId, session.user.id), eq(servers.id, requestedServerId)),
    );

  const clientIp = getClientIp(request);
  const clientIsLan = isPrivateIp(clientIp);

  const hosts = rows.map((row) => {
    const capabilities = classifyServerCapabilities(row.metadata);
    const lan = lanSummary(row.metadata);
    // Strip LAN URLs for non-LAN clients — prevents cellular/remote clients
    // from being redirected to unreachable private IPs like 192.168.x.x.
    const effectiveLan = clientIsLan ? lan : null;
    const effectiveCapabilities = clientIsLan
      ? capabilities
      : { ...capabilities, lan: false };

    return {
      server_id: row.serverId,
      name: row.serverName,
      status: classifyStatus(row.lastSeenAt),
      has_game: true,
      capabilities: effectiveCapabilities,
      lan: effectiveLan,
      role: row.role,
      metadata: row.metadata ?? {},
    };
  });

  return NextResponse.json({ hosts });
}
