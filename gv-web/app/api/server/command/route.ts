import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { commands, gameFiles, games, peerTokens, serverMembers, servers, sessions } from "@/lib/db/schema";
import { ACTIVE_SESSION_STATES, CMD_SDP_OFFER, CMD_START_GAME, CMD_STOP_GAME, CMD_BROWSE_FILES, CMD_SCAN_PATHS } from "@/lib/constants";
import { and, eq } from "drizzle-orm";
import { applyRateLimit } from "@/lib/rate-limit";
import { recordLaunchEvent } from "@/lib/launch-events";
import { waitForSdpAnswer } from "@/lib/pending-sdp";
import crypto from "crypto";

const COMMAND_RATE_LIMIT = 30; // requests per minute per IP

// ── Validation ─────────────────────────────────────────────────────────

const VALID_TYPES = new Set<string>([CMD_START_GAME, CMD_STOP_GAME, CMD_SDP_OFFER, CMD_BROWSE_FILES, CMD_SCAN_PATHS]);

interface CommandBody {
  server_id: string;
  type: string;
  payload?: unknown;
}


function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function validateCsrf(request: NextRequest): boolean {
  const headerToken = request.headers.get("x-csrf-token");
  const cookieToken = cookieValue(request.headers.get("cookie"), "gv_csrf_token");
  return !!headerToken && !!cookieToken && headerToken === cookieToken;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validatePayload(type: string, payload: unknown): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  if (!isPlainRecord(payload)) {
    return { ok: false, error: "payload must be an object" };
  }

  switch (type) {
    case CMD_START_GAME: {
      if (!hasOnlyKeys(payload, ["game_id", "host_token", "sdp", "lan"])) return { ok: false, error: "payload has unexpected fields" };
      if (typeof payload.game_id !== "string" || payload.game_id.length === 0) return { ok: false, error: "payload.game_id required" };
      if (payload.host_token !== undefined && typeof payload.host_token !== "string") return { ok: false, error: "payload.host_token must be string" };
      if (payload.sdp !== undefined && typeof payload.sdp !== "string") return { ok: false, error: "payload.sdp must be string" };
      if (payload.lan !== undefined && typeof payload.lan !== "boolean") return { ok: false, error: "payload.lan must be boolean" };
      return { ok: true, payload };
    }
    case CMD_STOP_GAME: {
      if (!hasOnlyKeys(payload, ["game_id"])) return { ok: false, error: "payload has unexpected fields" };
      if (typeof payload.game_id !== "string" || payload.game_id.length === 0) return { ok: false, error: "payload.game_id required" };
      return { ok: true, payload };
    }
    case CMD_SDP_OFFER: {
      if (!hasOnlyKeys(payload, ["game_id", "sdp", "host_token", "room_token", "peer_token", "lan"])) return { ok: false, error: "payload has unexpected fields" };
      if (typeof payload.game_id !== "string" || payload.game_id.length === 0) return { ok: false, error: "payload.game_id required" };
      if (typeof payload.sdp !== "string" || payload.sdp.length === 0) return { ok: false, error: "payload.sdp required" };
      if (payload.host_token !== undefined && typeof payload.host_token !== "string") return { ok: false, error: "payload.host_token must be string" };
      if (payload.room_token !== undefined && typeof payload.room_token !== "string") return { ok: false, error: "payload.room_token must be string" };
      if (payload.peer_token !== undefined && typeof payload.peer_token !== "string") return { ok: false, error: "payload.peer_token must be string" };
      return { ok: true, payload };
    }
    case CMD_BROWSE_FILES: {
      if (!hasOnlyKeys(payload, ["path"])) return { ok: false, error: "payload has unexpected fields" };
      if (typeof payload.path !== "string") return { ok: false, error: "payload.path required" };
      return { ok: true, payload };
    }
    case CMD_SCAN_PATHS: {
      if (!hasOnlyKeys(payload, ["paths"])) return { ok: false, error: "payload has unexpected fields" };
      if (!Array.isArray(payload.paths) || !payload.paths.every((p) => typeof p === "string")) return { ok: false, error: "payload.paths must be string[]" };
      return { ok: true, payload };
    }
    default:
      return { ok: false, error: "invalid type" };
  }
}

// ── Handler ────────────────────────────────────────────────────────────

/**
 * POST /api/server/command
 *
 * Authenticated user queues a command for one of their servers.
 * Only server owners (admins in server_members) can enqueue commands.
 *
 * Returns a `worker_token` that the browser uses to poll for the
 * resulting worker URL (see /api/server/notify).
 */
export async function POST(request: NextRequest) {
  // Rate limiting — 30 req/min per IP
  const rateLimited = applyRateLimit(request, COMMAND_RATE_LIMIT);
  if (rateLimited) return rateLimited;

  const session = await auth();
  let serverId: string;

  let body: CommandBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Validate type
  if (!body.type || !VALID_TYPES.has(body.type)) {
    return NextResponse.json(
      { error: `invalid type — must be one of: ${[...VALID_TYPES].join(", ")}` },
      { status: 400 },
    );
  }

  // ── Guest join via room_token (sdp_offer only) ────────────────────
  if (body.type === CMD_SDP_OFFER) {
    const sdpPayload = body.payload as Record<string, unknown> | undefined;
    const roomToken = sdpPayload?.room_token as string | undefined;
    if (roomToken) {
      // Resolve room_token → active session → server_id
      const [roomSession] = await db
        .select({ serverId: sessions.serverId, status: sessions.status })
        .from(sessions)
        .where(eq(sessions.roomToken, roomToken))
        .limit(1);

      if (!roomSession) {
        return NextResponse.json({ error: "invalid room_token" }, { status: 403 });
      }
      if (roomSession.status === "stopped" || roomSession.status === "ended") {
        return NextResponse.json({ error: "session ended" }, { status: 410 });
      }
      serverId = roomSession.serverId!;
      // Guest auth successful — skip session + CSRF + membership checks
    } else {
      // No room_token — fall through to normal auth
      if (!session?.user?.id) {
        return NextResponse.json({ error: "sign in first" }, { status: 401 });
      }
      if (!validateCsrf(request)) {
        return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });
      }
      // Verify the user owns this server (admin role)
      const [membership] = await db
        .select({ role: serverMembers.role })
        .from(serverMembers)
        .innerJoin(servers, eq(servers.id, serverMembers.serverId))
        .where(
          and(
            eq(serverMembers.serverId, body.server_id),
            eq(serverMembers.userId, session.user.id),
            eq(serverMembers.role, "admin"),
          ),
        )
        .limit(1);
      if (!membership) {
        return NextResponse.json(
          { error: "server not found or not authorized" },
          { status: 403 },
        );
      }
      serverId = body.server_id;
    }
  } else {
    // Non-sdp_offer commands require normal auth
    if (!session?.user?.id) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    if (!validateCsrf(request)) {
      return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });
    }
    // Verify the user owns this server (admin role)
    const [membership] = await db
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .innerJoin(servers, eq(servers.id, serverMembers.serverId))
      .where(
        and(
          eq(serverMembers.serverId, body.server_id),
          eq(serverMembers.userId, session.user.id),
          eq(serverMembers.role, "admin"),
        ),
      )
      .limit(1);
    if (!membership) {
      return NextResponse.json(
        { error: "server not found or not authorized" },
        { status: 403 },
      );
    }
    serverId = body.server_id;
  }

  const payloadResult = validatePayload(body.type, body.payload ?? {});
  if (!payloadResult.ok) {
    return NextResponse.json({ error: payloadResult.error }, { status: 400 });
  }

  // Generate a worker token — used by the browser to prove it created
  // this command when polling for the worker URL.
  const workerToken = crypto.randomBytes(16).toString("hex");

  // ── Enrich start_game payload with resolved ROM path ────────────────

  let enrichedPayload: Record<string, unknown> = payloadResult.payload;

  if (body.type === CMD_START_GAME) {
    const sp = payloadResult.payload;
    if (typeof sp.game_id === "string") {
      // ── LAN detection: check if client is on the same subnet as gv-server ──
      const clientIp =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        "";
      const lanIpsRaw = process.env.GV_SERVER_LAN_IPS || "";
      let isLan = false;
      if (clientIp && lanIpsRaw) {
        const lanIps = lanIpsRaw.split(",").map((s) => s.trim()).filter(Boolean);
        const clientPrefix = clientIp.split(".").slice(0, 3).join(".");
        isLan = lanIps.some((lanIp) => {
          if (lanIp === clientIp) return true;
          const lanPrefix = lanIp.split(".").slice(0, 3).join(".");
          return lanPrefix === clientPrefix;
        });
      }
      if (isLan) {
        console.log("[COMMAND] LAN detected for", clientIp, "— enabling direct ICE");
        enrichedPayload = { ...sp, lan: true };
      }

      // Look up the game and its file on this server
      const [gameFile] = await db
        .select({
          romPath: gameFiles.romPath,
          platform: games.platform,
          gameName: games.name,
        })
        .from(gameFiles)
        .innerJoin(games, eq(gameFiles.gameId, games.id))
        .where(
          and(
            eq(gameFiles.gameId, sp.game_id as string),
            eq(gameFiles.serverId, serverId),
          ),
        )
        .limit(1);

      if (gameFile) {
        enrichedPayload = {
          ...enrichedPayload,
          rom_path: gameFile.romPath,
          platform: gameFile.platform,
          game_name: gameFile.gameName,
        };
      } else {
        return NextResponse.json(
          { error: `game ${sp.game_id} not found on this server` },
          { status: 404 },
        );
      }
    }
  } else if (body.type === CMD_SDP_OFFER) {
    // Enrich with peer_role/peer_seat from peerTokens DB
    const sp = payloadResult.payload;
    const peerToken = sp.peer_token as string | undefined;
    if (peerToken) {
      const [peer] = await db
        .select({ role: peerTokens.role, seat: peerTokens.seat })
        .from(peerTokens)
        .where(eq(peerTokens.token, peerToken))
        .limit(1);
      if (peer) {
        enrichedPayload = {
          ...sp,
          peer_role: peer.role,
          peer_seat: peer.seat,
        };
      }
    }
  }

  // Insert command
  const [cmd] = await db
    .insert(commands)
    .values({
      serverId: serverId,
      type: body.type,
      payload: enrichedPayload,
      workerToken,
    })
    .returning({ id: commands.id });

  await recordLaunchEvent({
    commandId: cmd.id,
    serverId,
    gameId: typeof enrichedPayload.game_id === "string" ? enrichedPayload.game_id : null,
    source: "gv-web",
    event: "command_inserted",
    detail: { command_type: body.type },
  });

  // For sdp_offer commands, also record the offer sent event
  if (body.type === CMD_SDP_OFFER) {
    await recordLaunchEvent({
      commandId: cmd.id,
      serverId,
      gameId: typeof enrichedPayload.game_id === "string" ? enrichedPayload.game_id : null,
      source: "gv-web",
      event: "sdp_offer_sent",
      detail: {},
    });
  }

  // ── Session lifecycle ────────────────────────────────────────────

  let hostPeerToken: string | undefined;

  if (body.type === CMD_START_GAME) {
    const hostToken = (payloadResult.payload as any).host_token as string | undefined;
    const userId = (session?.user?.id as string) || undefined;
    if (!userId) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    const uid: string = userId;

    // End any active sessions owned by the same host_token.
    // This implements "starting a new game kills the old one."
    // Also grab the last room_token so the share link survives restarts.
    let recycledRoomToken: string | null = null;
    if (hostToken) {
      const victims = await db
        .select({ id: sessions.id, gameId: sessions.gameId, roomToken: sessions.roomToken })
        .from(sessions)
        .where(
          and(
            eq(sessions.hostToken, hostToken),
            eq(sessions.serverId, serverId),
          ),
        );
      for (const v of victims) {
        // Reuse the room_token from a session for the same game
        if (v.gameId === (enrichedPayload.game_id as string) && v.roomToken) {
          recycledRoomToken = v.roomToken;
        }
        await db
          .update(sessions)
          .set({ status: "ended", endedAt: new Date(), roomToken: null })
          .where(eq(sessions.id, v.id));
      }
    }

    // Create a fresh session in "spawning" state.
    // The server will transition it to "ready" when the worker is up.
    const [newSession] = await db.insert(sessions).values({
      userId: uid,
      serverId,
      gameId: enrichedPayload.game_id as string,
      commandId: cmd.id,
      hostToken: hostToken ?? null,
      roomToken: recycledRoomToken,
      status: "spawning",
      generation: 1, // first generation for this session
      stateEnteredAt: new Date(),
    }).returning({ id: sessions.id });

    // Include session_id in enriched payload so gv-server can echo it
    // back in notify calls (generation-scoped routing).
    enrichedPayload = {
      ...enrichedPayload,
      session_id: newSession.id,
    };

    // Issue host peer_token — seat 0, role host
    hostPeerToken = crypto.randomBytes(16).toString("hex");
    await db.insert(peerTokens).values({
      sessionId: newSession.id,
      token: hostPeerToken,
      seat: 0,
      role: "host",
    });

    // Attach peer_tokens to enriched payload for gv-server to pass to worker
    enrichedPayload = {
      ...enrichedPayload,
      peer_tokens: [{ token: hostPeerToken, seat: 0, role: "host" }],
    };

    // Update the already-inserted command with peer_tokens
    await db
      .update(commands)
      .set({ payload: enrichedPayload })
      .where(eq(commands.id, cmd.id));
  }

  if (body.type === CMD_STOP_GAME) {
    const gameId = (payloadResult.payload as any).game_id as string;
    await db
      .update(sessions)
      .set({ status: "ended", endedAt: new Date(), roomToken: null })
      .where(
        and(
          eq(sessions.gameId, gameId),
          eq(sessions.serverId, serverId),
          eq(sessions.status, "ready"),
        ),
      );
  }

  // ── Long-poll: if this is a start_game with SDP, hold the response
  //     open until gv-server processes the command and sends the answer
  //     back via the notify endpoint.  Eliminates browser-side polling.
  if (body.type === CMD_START_GAME && enrichedPayload.sdp) {
    try {
      const sdpAnswer = await waitForSdpAnswer(cmd.id);
      return NextResponse.json(
        {
          id: cmd.id,
          worker_token: workerToken,
          host_peer_token: hostPeerToken,
          sdp_answer: sdpAnswer,
        },
        { status: 201 },
      );
    } catch (err: any) {
      return NextResponse.json(
        {
          id: cmd.id,
          worker_token: workerToken,
          host_peer_token: hostPeerToken,
          error: err?.message || "SDP answer timed out",
        },
        { status: 202 },
      );
    }
  }

  return NextResponse.json(
    { id: cmd.id, worker_token: workerToken, host_peer_token: body.type === CMD_START_GAME ? hostPeerToken : undefined },
    { status: 201 },
  );
}
