import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverGames, serverMembers } from "@/lib/db/schema";
import { RETROARCH_TYPES, retroarchPlatform, signRetroarchCandidate, type RetroarchArtworkType } from "@/lib/cover-candidates";

export const runtime = "nodejs";

type Params = { params: Promise<{ server_id: string; game_id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const { server_id: serverId, game_id: gameId } = await params;
  const [membership] = await db.select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, session.user.id))).limit(1);
  if (!membership) return NextResponse.json({ error: "server not found" }, { status: 404 });
  if (membership.role !== "admin") return NextResponse.json({ error: "administrator access required" }, { status: 403 });
  const [game] = await db.select({
    name: serverGames.name,
    sourceName: serverGames.sourceName,
    thumbnailName: serverGames.thumbnailName,
    canonicalTitle: serverGames.canonicalTitle,
    region: serverGames.region,
    platform: serverGames.platform,
  }).from(serverGames).where(and(eq(serverGames.serverId, serverId), eq(serverGames.gameId, gameId))).limit(1);
  if (!game) return NextResponse.json({ error: "game not found" }, { status: 404 });

  const url = new URL(request.url);
  const requestedType = url.searchParams.get("type") ?? "boxart";
  if (!(requestedType in RETROARCH_TYPES)) return NextResponse.json({ error: "unsupported artwork type" }, { status: 400 });
  const type = requestedType as RetroarchArtworkType;
  const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
  const titles = [...new Set([
    game.thumbnailName,
    game.sourceName,
    game.canonicalTitle && game.region ? `${game.canonicalTitle} (${game.region})` : game.canonicalTitle,
  ].filter((title): title is string => !!title))]
    .filter((title) => !query || title.toLocaleLowerCase().includes(query))
    .slice(0, 24);
  const platform = retroarchPlatform(game.platform);
  return NextResponse.json({
    candidates: titles.map((title) => ({
      id: signRetroarchCandidate({ serverId, gameId, platform, type, title }),
      type,
      title,
      previewUrl: `/api/servers/${encodeURIComponent(serverId)}/games/${encodeURIComponent(gameId)}/cover/candidates/preview?id=${encodeURIComponent(signRetroarchCandidate({ serverId, gameId, platform, type, title }))}`,
      attribution: "RetroArch thumbnail database",
    })),
  });
}
