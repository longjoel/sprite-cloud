import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  commands,
  gameFiles,
  games,
  peerTokens,
  sessions,
  serverMembers,
  servers,
} from "@/lib/db/schema";
import { CMD_START_GAME } from "@/lib/constants";
import { eq, and, desc } from "drizzle-orm";
import crypto from "crypto";

// ── In-memory worker URL cache ─────────────────────────────────────────
const workerCache = new Map<string, { workerUrl: string; serverId: string }>();

const WORKER_POLL_TIMEOUT_MS = 30_000;
const WORKER_POLL_INTERVAL_MS = 500;

// ── Types ──────────────────────────────────────────────────────────────

interface RouteParams {
  game_id: string;
  path?: string[];
}

// ── Auth helpers ───────────────────────────────────────────────────────

type GameAccess =
  | { kind: "admin"; serverId: string; sessionId?: string }
  | { kind: "guest"; serverId: string; sessionId: string; roomToken: string }
  | { kind: "none" };

async function resolveAccess(
  request: NextRequest,
): Promise<GameAccess> {
  const session = await auth();
  const roomToken = request.nextUrl.searchParams.get("room_token");
  const explicitServerId = request.nextUrl.searchParams.get("server_id");

  // ── Guest via room_token ──
  if (roomToken) {
    const [room] = await db
      .select({
        id: sessions.id,
        serverId: sessions.serverId,
        status: sessions.status,
        workerUrl: sessions.workerUrl,
      })
      .from(sessions)
      .where(eq(sessions.roomToken, roomToken))
      .limit(1);

    if (room && room.serverId && room.status !== "ended" && room.status !== "stopped") {
      // Cache worker URL if already available
      if (room.workerUrl) {
        workerCache.set(request.nextUrl.pathname.split("/")[3], {
          workerUrl: room.workerUrl,
          serverId: room.serverId,
        });
      }
      return { kind: "guest", serverId: room.serverId, sessionId: room.id, roomToken };
    }
    // Invalid/expired room token — fall through to 403
  }

  // ── Admin auth ──
  if (session?.user?.id) {
    let serverId = explicitServerId;

    if (!serverId) {
      // Pick first server the user owns
      const [member] = await db
        .select({ serverId: serverMembers.serverId })
        .from(serverMembers)
        .innerJoin(servers, eq(servers.id, serverMembers.serverId))
        .where(
          and(
            eq(serverMembers.userId, session.user.id),
            eq(serverMembers.role, "admin"),
          ),
        )
        .limit(1);
      if (member) serverId = member.serverId;
    }

    if (serverId) {
      return { kind: "admin", serverId };
    }
  }

  return { kind: "none" };
}

// ── Worker start / poll ────────────────────────────────────────────────

async function startGame(
  gameId: string,
  serverId: string,
): Promise<{ sessionId: string; workerToken: string } | null> {
  const [gameFile] = await db
    .select({ romPath: gameFiles.romPath, platform: games.platform })
    .from(gameFiles)
    .innerJoin(games, eq(gameFiles.gameId, games.id))
    .where(and(eq(gameFiles.gameId, gameId), eq(gameFiles.serverId, serverId)))
    .limit(1);

  if (!gameFile) return null;

  const workerToken = crypto.randomBytes(16).toString("hex");
  const hostPeerToken = crypto.randomBytes(16).toString("hex");
  const userId = (await auth())?.user?.id ?? "";

  const [cmd] = await db
    .insert(commands)
    .values({
      serverId,
      type: CMD_START_GAME,
      payload: {
        game_id: gameId,
        rom_path: gameFile.romPath,
        platform: gameFile.platform,
        peer_tokens: [{ token: hostPeerToken, seat: 0, role: "host" }],
      },
      workerToken,
    })
    .returning({ id: commands.id });

  const [sess] = await db
    .insert(sessions)
    .values({
      userId,
      serverId,
      gameId,
      commandId: cmd.id,
      status: "spawning",
      stateEnteredAt: new Date(),
    })
    .returning({ id: sessions.id });

  // Insert host peer token
  await db.insert(peerTokens).values({
    sessionId: sess.id,
    token: hostPeerToken,
    seat: 0,
    role: "host",
  });

  return { sessionId: sess.id, workerToken };
}

async function pollSessionWorkerUrl(sessionId: string): Promise<string | null> {
  const deadline = Date.now() + WORKER_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [sess] = await db
      .select({ workerUrl: sessions.workerUrl, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (sess?.workerUrl) return sess.workerUrl;
    if (sess?.status === "ended" || sess?.status === "timed_out") return null;

    await new Promise((r) => setTimeout(r, WORKER_POLL_INTERVAL_MS));
  }
  return null;
}

// ── GET handler ────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<RouteParams> },
) {
  const { game_id, path: pathParts } = await params;
  const pathStr = (pathParts ?? []).join("/");
  // Ensure asset URLs resolve correctly via <base> tag.
  // The initial page is now always served with a trailing path (/player/),
  // so relative asset URLs naturally resolve from the correct base.
  const needsBaseTag = false;  // no longer needed with /player/ redirect

  // ── Auth ──
  const access = await resolveAccess(request);
  if (access.kind === "none") {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  // ── Resolve worker URL ──
  let workerUrl: string | null | undefined = workerCache.get(game_id)?.workerUrl;

  if (!workerUrl) {
    if (access.kind === "guest") {
      // Guest: poll existing session for worker URL
      workerUrl = await pollSessionWorkerUrl(access.sessionId);
    } else {
      // Admin: check for existing active session first
      const [existing] = await db
        .select({ workerUrl: sessions.workerUrl, id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.gameId, game_id),
            eq(sessions.serverId, access.serverId),
          ),
        )
        .orderBy(desc(sessions.createdAt))
        .limit(1);

      if (existing?.workerUrl) {
        workerUrl = existing.workerUrl;
        workerCache.set(game_id, { workerUrl, serverId: access.serverId });
      } else {
        // Start a new game + poll for worker URL
        const start = await startGame(game_id, access.serverId);
        if (start) {
          workerUrl = await pollSessionWorkerUrl(start.sessionId);
        }
      }
    }

    if (workerUrl) {
      workerCache.set(game_id, { workerUrl, serverId: access.serverId });
    }
  }

  if (!workerUrl) {
    return NextResponse.json(
      { error: "failed to start worker — game may be unavailable" },
      { status: 503 },
    );
  }

  // ── Forward to worker ──
  // pathStr already contains the worker path prefix (e.g. "player" for the
  // HTML page, "player/player-bundle.js" for JS assets).  Prepend "/" only.
  const targetPath = "/" + pathStr;
  const targetUrl = `${workerUrl.replace(/\/$/, "")}${targetPath}`;

  let resp: Response;
  try {
    resp = await fetch(targetUrl, { signal: AbortSignal.timeout(10_000) });
  } catch {
    // Worker died — clear cache, retry once
    workerCache.delete(game_id);
    if (access.kind === "admin") {
      const start = await startGame(game_id, access.serverId);
      if (!start) {
        return NextResponse.json({ error: "worker unreachable" }, { status: 502 });
      }
      const newWorkerUrl = await pollSessionWorkerUrl(start.sessionId);
      if (!newWorkerUrl) {
        return NextResponse.json({ error: "worker unreachable" }, { status: 502 });
      }
      workerCache.set(game_id, { workerUrl: newWorkerUrl, serverId: access.serverId });
      const retryUrl = `${newWorkerUrl.replace(/\/$/, "")}${targetPath}`;
      resp = await fetch(retryUrl, { signal: AbortSignal.timeout(10_000) });
    } else {
      return NextResponse.json({ error: "worker unreachable" }, { status: 502 });
    }
  }

  if (!resp.ok) {
    return NextResponse.json(
      { error: `worker returned ${resp.status}` },
      { status: 502 },
    );
  }

  const contentType =
    resp.headers.get("content-type") || "application/octet-stream";
  let body = await resp.arrayBuffer();

  // Inject <base> tag for correct relative asset resolution
  if (needsBaseTag && contentType.includes("text/html")) {
    const decoder = new TextDecoder();
    let html = decoder.decode(body);
    const baseHref = request.nextUrl.pathname + "/";
    html = html.replace(
      "<head>",
      `<head><base href="${baseHref}">`,
    );
    body = new TextEncoder().encode(html).buffer;
  }

  return new NextResponse(body, {
    status: resp.status,
    headers: { "Content-Type": contentType },
  });
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
