import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { games, gameFiles, serverMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

// ── PUT /api/games/:id ─────────────────────────────────────────────────
//
// Rename a game. Only server members can rename games that exist on
// their servers. Slug is NOT changed — it stays based on the original
// filename so re-scans continue to deduplicate correctly.
//
// Body: { name: string }

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const { id: gameId } = await params;

  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const newName = body.name?.trim();
  if (!newName) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  if (newName.length > 200) {
    return NextResponse.json({ error: "name too long (max 200)" }, { status: 400 });
  }

  // Verify user is a member of at least one server that has this game
  const [membership] = await db
    .select({ serverId: gameFiles.serverId })
    .from(gameFiles)
    .innerJoin(serverMembers, and(
      eq(serverMembers.serverId, gameFiles.serverId),
      eq(serverMembers.userId, session.user.id),
    ))
    .where(eq(gameFiles.gameId, gameId))
    .limit(1);

  if (!membership) {
    return NextResponse.json(
      { error: "game not found or not authorized" },
      { status: 403 },
    );
  }

  await db
    .update(games)
    .set({ name: newName, nameSource: "user" })
    .where(eq(games.id, gameId));

  return NextResponse.json({ ok: true, name: newName });
}

// ── GET /api/games/:id ─────────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const { id: gameId } = await params;

  const [game] = await db
    .select({
      id: games.id,
      name: games.name,
      slug: games.slug,
      platform: games.platform,
      maxPlayers: games.maxPlayers,
      nameSource: games.nameSource,
    })
    .from(games)
    .where(eq(games.id, gameId))
    .limit(1);

  if (!game) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(game);
}
