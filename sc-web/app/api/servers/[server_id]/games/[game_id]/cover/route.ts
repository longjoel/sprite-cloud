import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverGameCoverOverrides, serverGames, serverMembers } from "@/lib/db/schema";
import { retroarchCandidateUrl, verifyRetroarchCandidate } from "@/lib/cover-candidates";
import { coverStorageCapability, normalizeCover, persistCover, readBoundedBody, removeCoverAssets } from "@/lib/cover-storage";

export const runtime = "nodejs";
type Params = { params: Promise<{ server_id: string; game_id: string }> };

function cookieValue(header: string | null, name: string) {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}
function validCsrf(request: NextRequest) {
  const header = request.headers.get("x-csrf-token");
  const cookie = cookieValue(request.headers.get("cookie"), "sc_csrf_token");
  return !!header && !!cookie && decodeURIComponent(cookie) === header;
}
async function adminGame(userId: string, serverId: string, gameId: string) {
  const [membership] = await db.select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId))).limit(1);
  if (!membership) return { error: NextResponse.json({ error: "server not found" }, { status: 404 }) };
  if (membership.role !== "admin") return { error: NextResponse.json({ error: "administrator access required" }, { status: 403 }) };
  const [game] = await db.select({ gameId: serverGames.gameId }).from(serverGames)
    .where(and(eq(serverGames.serverId, serverId), eq(serverGames.gameId, gameId))).limit(1);
  if (!game) return { error: NextResponse.json({ error: "game not found" }, { status: 404 }) };
  return { game };
}

export async function GET(_request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const { server_id: serverId, game_id: gameId } = await params;
  const [membership] = await db.select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, session.user.id))).limit(1);
  if (!membership) return NextResponse.json({ error: "server not found" }, { status: 404 });
  const [override] = await db.select({
    sourceType: serverGameCoverOverrides.sourceType,
    mediaType: serverGameCoverOverrides.mediaType,
    animated: serverGameCoverOverrides.animated,
    updatedAt: serverGameCoverOverrides.updatedAt,
  }).from(serverGameCoverOverrides).where(and(eq(serverGameCoverOverrides.serverId, serverId), eq(serverGameCoverOverrides.gameId, gameId))).limit(1);
  return NextResponse.json({
    override: override ? { ...override, coverUrl: `/api/covers/${encodeURIComponent(serverId)}/${encodeURIComponent(gameId)}` } : null,
    capabilities: { ...coverStorageCapability(), canManage: membership.role === "admin" },
    defaultCoverUrl: `/api/covers/${encodeURIComponent(serverId)}/${encodeURIComponent(gameId)}?default=1`,
  });
}

async function save(userId: string, serverId: string, gameId: string, input: Buffer, sourceType: "upload" | "retroarch", providerKey?: string) {
  const normalized = await normalizeCover(input);
  const assets = await persistCover(normalized);
  let existing: { assetId: string; posterAssetId: string } | undefined;
  try {
    existing = await db.transaction(async (tx) => {
      // Serialize replacement for one server/game across gateway replicas so a
      // losing concurrent save cannot orphan or delete the winning asset.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${serverId}:${gameId}`}, 0))`);
      const [previous] = await tx.select({ assetId: serverGameCoverOverrides.assetId, posterAssetId: serverGameCoverOverrides.posterAssetId })
        .from(serverGameCoverOverrides).where(and(eq(serverGameCoverOverrides.serverId, serverId), eq(serverGameCoverOverrides.gameId, gameId))).limit(1);
      await tx.insert(serverGameCoverOverrides).values({
        serverId, gameId, sourceType, ...assets, mediaType: normalized.mediaType,
        width: normalized.width, height: normalized.height, byteSize: normalized.bytes.length,
        animated: normalized.animated, frameCount: normalized.frameCount, providerKey, updatedBy: userId,
      }).onConflictDoUpdate({
        target: [serverGameCoverOverrides.serverId, serverGameCoverOverrides.gameId],
        set: { sourceType, ...assets, mediaType: normalized.mediaType, width: normalized.width, height: normalized.height,
          byteSize: normalized.bytes.length, animated: normalized.animated, frameCount: normalized.frameCount,
          providerKey, updatedBy: userId, updatedAt: new Date() },
      });
      return previous;
    });
  } catch (error) {
    await removeCoverAssets([assets.assetId, assets.posterAssetId]);
    throw error;
  }
  // The database now owns the new assets. Superseded-file cleanup must never
  // turn a committed save into a broken override.
  await removeCoverAssets([existing?.assetId, existing?.posterAssetId]).catch(() => undefined);
  return { coverUrl: `/api/covers/${encodeURIComponent(serverId)}/${encodeURIComponent(gameId)}?v=${Date.now()}`, animated: normalized.animated };
}

export async function POST(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const { server_id: serverId, game_id: gameId } = await params;
  const access = await adminGame(session.user.id, serverId, gameId);
  if (access.error) return access.error;
  if (!validCsrf(request)) return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });
  if (!coverStorageCapability().configured) return NextResponse.json({ error: "cover storage is not configured" }, { status: 503 });
  try {
    const bytes = await readBoundedBody(request.body);
    return NextResponse.json({ override: await save(session.user.id, serverId, gameId, bytes, "upload") });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "invalid cover" }, { status: 400 });
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (!validCsrf(request)) return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });
  const { server_id: serverId, game_id: gameId } = await params;
  const access = await adminGame(session.user.id, serverId, gameId);
  if (access.error) return access.error;
  if (!coverStorageCapability().configured) return NextResponse.json({ error: "cover storage is not configured" }, { status: 503 });
  let candidateId: string | undefined;
  try { candidateId = (await request.json() as { candidateId?: string }).candidateId; } catch { /* invalid below */ }
  const candidate = candidateId ? verifyRetroarchCandidate(candidateId) : null;
  if (!candidate || candidate.serverId !== serverId || candidate.gameId !== gameId) return NextResponse.json({ error: "invalid artwork candidate" }, { status: 400 });
  try {
    const response = await fetch(retroarchCandidateUrl(candidate), { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) return NextResponse.json({ error: "artwork is unavailable" }, { status: 404 });
    const bytes = await readBoundedBody(response.body);
    return NextResponse.json({ override: await save(session.user.id, serverId, gameId, bytes, "retroarch", candidateId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "artwork is unavailable" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (!validCsrf(request)) return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });
  const { server_id: serverId, game_id: gameId } = await params;
  const access = await adminGame(session.user.id, serverId, gameId);
  if (access.error) return access.error;
  const existing = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${serverId}:${gameId}`}, 0))`);
    const [previous] = await tx.select({ assetId: serverGameCoverOverrides.assetId, posterAssetId: serverGameCoverOverrides.posterAssetId })
      .from(serverGameCoverOverrides).where(and(eq(serverGameCoverOverrides.serverId, serverId), eq(serverGameCoverOverrides.gameId, gameId))).limit(1);
    await tx.delete(serverGameCoverOverrides).where(and(eq(serverGameCoverOverrides.serverId, serverId), eq(serverGameCoverOverrides.gameId, gameId)));
    return previous;
  });
  await removeCoverAssets([existing?.assetId, existing?.posterAssetId]).catch(() => undefined);
  return NextResponse.json({ ok: true, coverUrl: `/api/covers/${encodeURIComponent(serverId)}/${encodeURIComponent(gameId)}?v=${Date.now()}` });
}
