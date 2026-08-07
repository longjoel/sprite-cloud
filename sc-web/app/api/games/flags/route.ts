import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { gameFlags, serverGames, serverMembers } from "@/lib/db/schema";

// ── PATCH /api/games/flags ────────────────────────────────────────────
//
// Gateway-owned per-game flags (Living Cabinet wall, #762): alwaysOn,
// freePlay, and public. Admin-only for the game's server.
//
// Body: { serverId, gameId, alwaysOn?, freePlay?, public? }  (at least one flag)
// Response: { flags: { alwaysOn, freePlay, public, updatedAt } }

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function validCsrf(request: NextRequest): boolean {
  const header = request.headers.get("x-csrf-token");
  const cookie = cookieValue(request.headers.get("cookie"), "sc_csrf_token");
  return !!header && !!cookie && header === cookie;
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (!validCsrf(request)) return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const { serverId, gameId, alwaysOn, freePlay, public: isPublic } = (body ?? {}) as Record<string, unknown>;

  if (typeof serverId !== "string" || typeof gameId !== "string" || !serverId || !gameId) {
    return NextResponse.json({ error: "serverId and gameId are required" }, { status: 400 });
  }
  if (alwaysOn !== undefined && typeof alwaysOn !== "boolean") {
    return NextResponse.json({ error: "alwaysOn must be a boolean" }, { status: 400 });
  }
  if (isPublic !== undefined && typeof isPublic !== "boolean") {
    return NextResponse.json({ error: "public must be a boolean" }, { status: 400 });
  }
  if (freePlay !== undefined && typeof freePlay !== "boolean") {
    return NextResponse.json({ error: "freePlay must be a boolean" }, { status: 400 });
  }
  if (alwaysOn === undefined && isPublic === undefined && freePlay === undefined) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const [membership] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, session.user.id)))
    .limit(1);
  if (!membership) return NextResponse.json({ error: "server not found" }, { status: 404 });
  if (membership.role !== "admin") {
    return NextResponse.json({ error: "administrator access required" }, { status: 403 });
  }

  const [game] = await db
    .select({ gameId: serverGames.gameId })
    .from(serverGames)
    .where(and(eq(serverGames.serverId, serverId), eq(serverGames.gameId, gameId)))
    .limit(1);
  if (!game) return NextResponse.json({ error: "game not found" }, { status: 404 });

  // Preserve unspecified flags from any existing row (defaults false).
  const [existing] = await db
    .select({ alwaysOn: gameFlags.alwaysOn, freePlay: gameFlags.freePlay, public: gameFlags.public })
    .from(gameFlags)
    .where(and(eq(gameFlags.serverId, serverId), eq(gameFlags.gameId, gameId)))
    .limit(1);

  const next = {
    alwaysOn: alwaysOn ?? existing?.alwaysOn ?? false,
    freePlay: freePlay ?? existing?.freePlay ?? false,
    public: isPublic ?? existing?.public ?? false,
  };

  const [saved] = await db
    .insert(gameFlags)
    .values({ serverId, gameId, ...next, updatedBy: session.user.id })
    .onConflictDoUpdate({
      target: [gameFlags.serverId, gameFlags.gameId],
      set: { ...next, updatedBy: session.user.id, updatedAt: new Date() },
    })
    .returning({ alwaysOn: gameFlags.alwaysOn, freePlay: gameFlags.freePlay, public: gameFlags.public, updatedAt: gameFlags.updatedAt });

  return NextResponse.json({ flags: saved ?? next });
}
