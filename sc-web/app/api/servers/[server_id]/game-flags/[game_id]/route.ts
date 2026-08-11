import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { gameFlags, serverMembers } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

// PATCH /api/servers/:server_id/game-flags/:game_id — toggle flags
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ server_id: string; game_id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { server_id, game_id } = await params;

  // Only server admins can toggle flags
  const [member] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, server_id),
        eq(serverMembers.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!member || member.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));

  const updates: Record<string, boolean | undefined> = {};
  if (typeof body.always_on === "boolean") updates.alwaysOn = body.always_on;
  if (typeof body.free_play === "boolean") updates.freePlay = body.free_play;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no valid flags" }, { status: 400 });
  }

  const setValues: Record<string, unknown> = {};
  if (updates.alwaysOn !== undefined) setValues.alwaysOn = updates.alwaysOn;
  if (updates.freePlay !== undefined) setValues.freePlay = updates.freePlay;
  setValues.updatedBy = session.user.id;
  setValues.updatedAt = new Date();

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ serverId: gameFlags.serverId })
      .from(gameFlags)
      .where(
        and(
          eq(gameFlags.serverId, server_id),
          eq(gameFlags.gameId, game_id),
        ),
      )
      .limit(1);

    if (existing) {
      await tx
        .update(gameFlags)
        .set(setValues)
        .where(
          and(
            eq(gameFlags.serverId, server_id),
            eq(gameFlags.gameId, game_id),
          ),
        );
    } else {
      await tx.insert(gameFlags).values({
        serverId: server_id,
        gameId: game_id,
        ...setValues,
      });
    }
  });

  return NextResponse.json({ ok: true });
}

// GET /api/servers/:server_id/game-flags/:game_id
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ server_id: string; game_id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { server_id, game_id } = await params;

  const [flag] = await db
    .select({
      alwaysOn: gameFlags.alwaysOn,
      freePlay: gameFlags.freePlay,
    })
    .from(gameFlags)
    .where(
      and(
        eq(gameFlags.serverId, server_id),
        eq(gameFlags.gameId, game_id),
      ),
    )
    .limit(1);

  return NextResponse.json(flag ?? { alwaysOn: false, freePlay: false });
}
