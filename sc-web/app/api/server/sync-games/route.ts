import { NextRequest, NextResponse } from "next/server";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import { db } from "@/lib/db";
import { serverGames } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

interface SyncGame {
  id: string;
  name: string;
  source_name?: string | null;
  thumbnail_name?: string | null;
  platform: string;
  max_players?: number;
  verification?: SyncVerification | null;
}

interface SyncVerification {
  state?: unknown;
  canonical_title?: unknown;
  canonical_platform?: unknown;
  region?: unknown;
  revision?: unknown;
  confidence?: unknown;
  catalog_name?: unknown;
  catalog_version?: unknown;
  catalog_sha256?: unknown;
  source_name?: unknown;
  enriched_at?: unknown;
}

function canonicalThumbnailName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  // Keep catalog input bounded before it becomes a remote URL segment.
  return name.length > 0 && name.length <= 300 ? name : null;
}

function boundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= 300 ? text : null;
}

/** Accept only the two meaningful verification states the server can send. */
function verificationState(value: unknown): string | null {
  return value === "verified" || value === "unverified" ? value : null;
}

function verificationValues(v: SyncVerification | null | undefined) {
  if (!v) return null;
  const state = verificationState(v.state);
  if (!state) return null;
  return {
    state,
    canonicalTitle: boundedText(v.canonical_title),
    canonicalPlatform: boundedText(v.canonical_platform),
    region: boundedText(v.region),
    revision: boundedText(v.revision),
    confidence: boundedText(v.confidence),
    catalogName: boundedText(v.catalog_name),
    catalogVersion: boundedText(v.catalog_version),
    catalogSha256: boundedText(v.catalog_sha256),
    verificationSourceName: boundedText(v.source_name),
    enrichedAt: boundedText(v.enriched_at),
  };
}

// POST /api/server/sync-games — sc-server pushes its game catalog to sc-web.
//
// Full-replace semantics: the server sends its entire current game list.
// All existing rows for this server are deleted, then the new list is inserted.
export async function POST(request: NextRequest) {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse();

  let body: { games?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!Array.isArray(body.games)) {
    return NextResponse.json({ error: "games array required" }, { status: 400 });
  }

  const incoming: SyncGame[] = (body.games as unknown[]).filter(
    (g): g is SyncGame => {
      const item = g as Record<string, unknown>;
      return typeof item.id === "string" && item.id.length > 0 &&
        typeof item.name === "string" && item.name.length > 0;
    },
  );

  // Delete all existing rows for this server
  await db
    .delete(serverGames)
    .where(eq(serverGames.serverId, server.id));

  // Insert incoming games
  let inserted = 0;
  for (const game of incoming) {
    const verification = verificationValues(game.verification);
    await db
      .insert(serverGames)
      .values({
        serverId: server.id,
        gameId: game.id,
        name: game.name,
        sourceName: game.source_name ?? null,
        thumbnailName: canonicalThumbnailName(game.thumbnail_name),
        platform: game.platform || "Unknown",
        maxPlayers: game.max_players ?? 1,
        verificationState: verification?.state ?? null,
        canonicalTitle: verification?.canonicalTitle ?? null,
        canonicalPlatform: verification?.canonicalPlatform ?? null,
        region: verification?.region ?? null,
        revision: verification?.revision ?? null,
        confidence: verification?.confidence ?? null,
        catalogName: verification?.catalogName ?? null,
        catalogVersion: verification?.catalogVersion ?? null,
        catalogSha256: verification?.catalogSha256 ?? null,
        verificationSourceName: verification?.verificationSourceName ?? null,
        enrichedAt: verification?.enrichedAt ?? null,
      })
      .onConflictDoUpdate({
        target: [serverGames.serverId, serverGames.gameId],
        set: {
          name: game.name,
          sourceName: game.source_name ?? null,
          thumbnailName: canonicalThumbnailName(game.thumbnail_name),
          platform: game.platform || "Unknown",
          maxPlayers: game.max_players ?? 1,
          verificationState: verification?.state ?? null,
          canonicalTitle: verification?.canonicalTitle ?? null,
          canonicalPlatform: verification?.canonicalPlatform ?? null,
          region: verification?.region ?? null,
          revision: verification?.revision ?? null,
          confidence: verification?.confidence ?? null,
          catalogName: verification?.catalogName ?? null,
          catalogVersion: verification?.catalogVersion ?? null,
          catalogSha256: verification?.catalogSha256 ?? null,
          verificationSourceName: verification?.verificationSourceName ?? null,
          enrichedAt: verification?.enrichedAt ?? null,
          updatedAt: new Date(),
        },
      });
    inserted++;
  }

  return NextResponse.json({ synced: inserted });
}
