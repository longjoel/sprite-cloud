import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers, games, gameFiles, pinnedGames } from "@/lib/db/schema";
import { eq, sql, inArray } from "drizzle-orm";

// ── GET /api/client/bootstrap ───────────────────────────────────────────
//
// Stable client bootstrap endpoint. Returns everything a native-ish shell
// (PWA, desktop, mobile) needs to render its first screen — auth state,
// server memberships, game library summary, ICE config status, and feature
// flags. Works for both authenticated and unauthenticated callers (returns
// less data when unauthenticated).
//
// Response shape:
// {
//   version: string,              // gv-web build version
//   auth: {
//     authenticated: boolean,
//     userId?: string,
//     name?: string,
//     email?: string,
//   },
//   servers: Array<{             // only when authenticated
//     id: string,
//     name: string,
//     hostname?: string,
//     gameCount: number,
//     lastSeenAt: string | null,
//     role: "admin" | "member",
//   }>,
//   library: {                    // only when authenticated
//     totalGames: number,
//     pinnedCount: number,
//   },
//   ice: {
//     stunConfigured: boolean,
//     turnConfigured: boolean,
//     transportPolicy: string,    // "all" | "relay"
//   },
//   features: {
//     pwa: boolean,
//     xmb: boolean,
//     guestPlay: boolean,         // room sharing enabled
//     multiController: boolean,
//   },
//   deepLinks: {
//     hostPattern: string,        // "/p/:code"
//     guestPattern: string,       // "/p/:code?join" or "/r/:roomToken"
//     resolvePattern: string,     // "/p/:code" for resolving shared links
//   },
// }

export async function GET() {
  // ── ICE config summary (no secrets) ───────────────────────────────
  const stunRaw = process.env.GV_ICE_STUN_URLS || "";
  const turnRaw = process.env.GV_ICE_TURN_URLS || "";
  const turnUsername = process.env.GV_ICE_TURN_USERNAME || "";
  const turnCredential = process.env.GV_ICE_TURN_CREDENTIAL || "";
  const configuredPolicy = process.env.GV_ICE_TRANSPORT_POLICY || "all";
  const ice = {
    stunConfigured: stunRaw.trim().length > 0,
    turnConfigured: turnRaw.trim().length > 0 && turnUsername.length > 0 && turnCredential.length > 0,
    transportPolicy: configuredPolicy === "relay" ? "relay" as const : "all" as const,
  };

  // ── Feature flags ─────────────────────────────────────────────────
  const features = {
    pwa: true,
    xmb: true,
    guestPlay: true,
    multiController: true,
  };

  // ── Deep-link resolution semantics ────────────────────────────────
  const deepLinks = {
    hostPattern: "/p/:code",      // short-code host/reconnect link
    guestPattern: "/p/:code?join", // guest join via share link
    resolvePattern: "/p/:code",    // resolve a share code to its game/session
  };

  // ── Auth check ────────────────────────────────────────────────────
  const session = await auth();

  const base = {
    version: process.env.NEXT_PUBLIC_APP_VERSION || "0.2.0",
    auth: session?.user?.id
      ? {
          authenticated: true as const,
          userId: session.user.id,
          name: session.user.name ?? undefined,
          email: session.user.email ?? undefined,
        }
      : {
          authenticated: false as const,
        },
    ice,
    features,
    deepLinks,
  };

  // ── Unauthenticated — return minimal bootstrap ──────────────────
  if (!session?.user?.id) {
    return NextResponse.json({
      ...base,
      servers: [],
      library: null,
    });
  }

  // ── Authenticated — enrich with server + library data ────────────

  // Server memberships
  const memberships = await db
    .select({
      id: servers.id,
      name: servers.name,
      lastSeenAt: servers.lastSeenAt,
      role: serverMembers.role,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, session.user.id));

  const serverIds = memberships.map((m) => m.id);

  // Game counts per server + total
  let serversWithCounts: Array<{
    id: string;
    name: string;
    gameCount: number;
    lastSeenAt: string | null;
    role: string;
  }> = [];

  if (serverIds.length > 0) {
    const counts = await db
      .select({
        serverId: gameFiles.serverId,
        count: sql<number>`count(DISTINCT ${games.id})`,
      })
      .from(games)
      .innerJoin(gameFiles, eq(games.id, gameFiles.gameId))
      .where(inArray(gameFiles.serverId, serverIds))
      .groupBy(gameFiles.serverId);

    const countMap = new Map(counts.map((c) => [c.serverId, Number(c.count)]));

    serversWithCounts = memberships.map((m) => ({
      id: m.id,
      name: m.name,
      gameCount: countMap.get(m.id) ?? 0,
      lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
      role: m.role,
    }));
  }

  // Pinned game count
  const [pinRow] = await db
    .select({ pinnedCount: sql<number>`count(*)` })
    .from(pinnedGames)
    .where(eq(pinnedGames.userId, session.user.id));
  const pinnedCount = Number(pinRow?.pinnedCount ?? 0);

  return NextResponse.json({
    ...base,
    servers: serversWithCounts,
    library: {
      totalGames: serversWithCounts.reduce((sum, s) => sum + s.gameCount, 0),
      pinnedCount,
    },
  });
}
