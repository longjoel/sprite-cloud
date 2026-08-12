import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverGames, serverMembers } from "@/lib/db/schema";
import { readBoundedBody } from "@/lib/cover-storage";
import { retroarchCandidateUrl, verifyRetroarchCandidate } from "@/lib/cover-candidates";

export const runtime = "nodejs";
type Params = { params: Promise<{ server_id: string; game_id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return new NextResponse("not found", { status: 404 });
  const { server_id: serverId, game_id: gameId } = await params;
  const [game] = await db.select({ gameId: serverGames.gameId }).from(serverGames).innerJoin(serverMembers,
    and(eq(serverMembers.serverId, serverGames.serverId), eq(serverMembers.userId, session.user.id)))
    .where(and(eq(serverGames.serverId, serverId), eq(serverGames.gameId, gameId))).limit(1);
  if (!game) return new NextResponse("not found", { status: 404 });
  const candidate = verifyRetroarchCandidate(new URL(request.url).searchParams.get("id") ?? "");
  if (!candidate || candidate.serverId !== serverId || candidate.gameId !== gameId) return new NextResponse("not found", { status: 404 });
  try {
    const upstream = await fetch(retroarchCandidateUrl(candidate), { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!upstream.ok) return new NextResponse("not found", { status: 404 });
    const bytes = await readBoundedBody(upstream.body);
    return new NextResponse(new Uint8Array(bytes).buffer, { headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  } catch { return new NextResponse("not found", { status: 404 }); }
}
