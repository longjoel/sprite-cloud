import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { commands, gameFiles, games, peerTokens, serverMembers, servers, sessions, shortCodes } from "@/lib/db/schema";
import { ACTIVE_SESSION_STATES, CMD_SDP_OFFER, CMD_START_GAME, CMD_STOP_GAME, CMD_BROWSE_FILES, CMD_SCAN_PATHS, SESSION_CONNECTED, SESSION_PLAYING, SESSION_READY, SESSION_SPAWNING, SESSION_STATE_TIMEOUT_MS } from "@/lib/constants";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { applyRateLimit } from "@/lib/rate-limit";
import { recordLaunchEvent } from "@/lib/launch-events";
import { waitForSdpAnswer } from "@/lib/pending-sdp";
import { classifyCommandFlow, logSignalingStage, type SignalingFlow } from "@/lib/signaling";
import crypto from "crypto";

const COMMAND_RATE_LIMIT = 30; // requests per minute per IP

// ── Validation ─────────────────────────────────────────────────────────

const VALID_TYPES = new Set<string>([CMD_START_GAME, CMD_STOP_GAME, CMD_SDP_OFFER, CMD_BROWSE_FILES, CMD_SCAN_PATHS]);
const RECONNECT_TRANSIENT_STATES = [SESSION_SPAWNING, SESSION_READY, SESSION_CONNECTED] as const;

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

  // Validate payload before any auth-mode branching so bearer LAN starts can
  // prove exactly which game/server/host token they claim.
  const payloadResult = validatePayload(body.type, body.payload ?? {});
  if (!payloadResult.ok) {
    return NextResponse.json({ error: payloadResult.error }, { status: 400 });
  }

  let lanStartUserId: string | undefined;

  // ── LAN host start via short-code bearer token ─────────────────────
  // The embedded LAN player runs on http://<server-ip>:8787, so it cannot
  // send lngnckr auth cookies. The library page creates a short-code row,
  // then sends host_token only in the LAN URL fragment. Accept start_game
  // without cookies only when that host_token matches the short-code row for
  // the selected server/game and the caller explicitly marks lan=true.
  const lanStartPayload = payloadResult.payload;
  if (
    body.type === CMD_START_GAME &&
    lanStartPayload.lan === true &&
    typeof lanStartPayload.host_token === "string" &&
    typeof lanStartPayload.game_id === "string"
  ) {
    const [shortCode] = await db
      .select({ code: shortCodes.code })
      .from(shortCodes)
      .where(
        and(
          eq(shortCodes.serverId, body.server_id),
          eq(shortCodes.gameId, lanStartPayload.game_id),
          eq(shortCodes.hostToken, lanStartPayload.host_token),
        ),
      )
      .limit(1);
    if (!shortCode) {
      return NextResponse.json({ error: "invalid LAN launch token" }, { status: 403 });
    }
    const [owner] = await db
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, body.server_id), eq(serverMembers.role, "admin")))
      .limit(1);
    if (!owner) {
      return NextResponse.json({ error: "server owner not found" }, { status: 403 });
    }
    lanStartUserId = owner.userId;
    serverId = body.server_id;
  } else if (body.type === CMD_SDP_OFFER) {
    const sdpPayload = body.payload as Record<string, unknown> | undefined;
    const roomToken = sdpPayload?.room_token as string | undefined;
    const peerToken = sdpPayload?.peer_token as string | undefined;
    console.log("[COMMAND] sdp_offer received — room_token:", !!roomToken, "peer_token:", !!peerToken);
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
      // Verify the user is a member of this server (admin or viewer)
      const [membership] = await db
        .select({ role: serverMembers.role })
        .from(serverMembers)
        .innerJoin(servers, eq(servers.id, serverMembers.serverId))
        .where(
          and(
            eq(serverMembers.serverId, body.server_id),
            eq(serverMembers.userId, session.user.id),
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
    // Verify the user is a member of this server (admin or viewer)
    const [membership] = await db
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .innerJoin(servers, eq(servers.id, serverMembers.serverId))
      .where(
        and(
          eq(serverMembers.serverId, body.server_id),
          eq(serverMembers.userId, session.user.id),
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

  const signalingFlow = classifyCommandFlow(body.type, payloadResult.payload);
  if (signalingFlow) {
    logSignalingStage(signalingFlow, "request_validated", {
      command_type: body.type,
      game_id: payloadResult.payload.game_id,
      has_host_token: typeof payloadResult.payload.host_token === "string",
      has_peer_token: typeof payloadResult.payload.peer_token === "string",
      has_room_token: typeof payloadResult.payload.room_token === "string",
      has_sdp: typeof payloadResult.payload.sdp === "string",
      server_id: serverId,
    });
  }

  // Generate a worker token — used by the browser to prove it created
  // this command when polling for the worker URL.
  const workerToken = crypto.randomBytes(16).toString("hex");

  // ── Enrich start_game payload with resolved ROM path ────────────────

  let enrichedPayload: Record<string, unknown> = payloadResult.payload;

  if (body.type === CMD_START_GAME) {
    const t0 = Date.now();
    const sp = payloadResult.payload;
    if (typeof sp.game_id === "string") {
      // Transport selection no longer guesses LAN proximity from public request
      // headers. gv-web cannot reliably infer RFC1918 locality relative to the
      // paired server from x-forwarded-for/x-real-ip, so command payloads must
      // not auto-enable a LAN/direct path based on gateway-side heuristics.
      if (sp.lan === true) {
        console.info("[COMMAND] start_game received explicit lan=true hint from caller — preserving explicit transport hint");
      } else {
        console.info("[COMMAND] start_game using deterministic transport selection — no gateway-side LAN auto-detection");
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
    // Invariant: guest/browser SDP offers carry peer_token and optionally room_token.
    // Host reconnect offers carry host_token and MUST NOT be enriched with guest role/seat.
    const sp = payloadResult.payload;
    const peerToken = sp.peer_token as string | undefined;
    logSignalingStage(peerToken ? "guest_offer" : "host_reconnect", "payload_enrichment_start", {
      command_type: body.type,
      game_id: sp.game_id,
      has_peer_token: !!peerToken,
      has_room_token: typeof sp.room_token === "string",
      has_host_token: typeof sp.host_token === "string",
    });
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
        logSignalingStage("guest_offer", "payload_enriched", {
          game_id: sp.game_id,
          peer_role: peer.role,
          peer_seat: peer.seat,
        });
      } else {
        logSignalingStage("guest_offer", "payload_enrichment_missing_peer", {
          game_id: sp.game_id,
          has_peer_token: true,
        });
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

  if (signalingFlow) {
    logSignalingStage(signalingFlow, "command_inserted", {
      command_id: cmd.id,
      command_type: body.type,
      game_id: typeof enrichedPayload.game_id === "string" ? enrichedPayload.game_id : undefined,
      has_host_token: typeof enrichedPayload.host_token === "string",
      has_peer_token: typeof enrichedPayload.peer_token === "string",
      server_id: serverId,
      worker_token: workerToken,
    });
  }

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
    const userId = ((session?.user?.id as string) || lanStartUserId) || undefined;
    if (!userId) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    const uid: string = userId;

    // ── Reconnect: if an active session already exists for this user + game,
    //     convert the start_game into an sdp_offer to avoid tearing down
    //     the running core and going through ICE gathering again. ──────
    if (enrichedPayload.sdp) {
      const reconnectCutoff = new Date(Date.now() - SESSION_STATE_TIMEOUT_MS);

      await db
        .update(sessions)
        .set({ status: "timed_out", endedAt: new Date(), stateEnteredAt: new Date() })
        .where(
          and(
            eq(sessions.userId, uid),
            eq(sessions.serverId, serverId),
            eq(sessions.gameId, enrichedPayload.game_id as string),
            inArray(sessions.status, [...RECONNECT_TRANSIENT_STATES]),
            lt(sessions.stateEnteredAt, reconnectCutoff),
          ),
        );

      const [existing] = await db
        .select({ id: sessions.id, commandId: sessions.commandId, roomToken: sessions.roomToken, status: sessions.status })
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, uid),
            eq(sessions.serverId, serverId),
            eq(sessions.gameId, enrichedPayload.game_id as string),
            inArray(sessions.status, [...RECONNECT_TRANSIENT_STATES, SESSION_PLAYING]),
          ),
        )
        .orderBy(desc(sessions.createdAt))
        .limit(1);

      if (existing) {
        // Invariant: host reconnect reuses the existing host session in-place.
        // It MUST carry host_token only — never peer_token — so gv-server stays on
        // the host reconnection path instead of the guest-PC creation path.
        logSignalingStage("host_reconnect", "reuse_existing_session", {
          command_id: cmd.id,
          existing_command_id: existing.commandId,
          game_id: enrichedPayload.game_id as string,
          session_id: existing.id,
          session_status: existing.status,
        });

        // NOTE: we do NOT include peer_token — this is a HOST reconnect,
        // not a guest join. Including peer_token would cause gv-server to
        // route the SDP exchange through handle_guest_sdp (building a new
        // PC with host track copies) instead of handle_sdp_offer's host
        // reconnection path (swapping the session PC in place).
        await db.update(commands).set({
          type: CMD_SDP_OFFER,
          payload: {
            game_id: enrichedPayload.game_id,
            sdp: enrichedPayload.sdp,
            host_token: hostToken,
          },
        }).where(eq(commands.id, cmd.id));

        // Issue a new host peer_token for this reconnect
        hostPeerToken = crypto.randomBytes(16).toString("hex");
        await db.insert(peerTokens).values({
          sessionId: existing.id,
          token: hostPeerToken,
          seat: 0,
          role: "host",
        });

        await recordLaunchEvent({
          commandId: cmd.id,
          sessionId: existing.id,
          serverId,
          gameId: enrichedPayload.game_id as string,
          source: "gv-web",
          event: "host_reconnect",
          detail: {},
        });

        // Return immediately — no need to long-poll for SDP answer on reconnect
        logSignalingStage("host_reconnect", "response_ready", {
          command_id: cmd.id,
          host_peer_token: hostPeerToken,
          session_id: existing.id,
          worker_token: workerToken,
        });
        return NextResponse.json(
          { id: cmd.id, worker_token: workerToken, host_peer_token: hostPeerToken },
          { status: 201 },
        );
      }
    }

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

    // Invariant: a fresh host launch always creates a new DB session row in
    // spawning state. gv-server owns the ready/connected transitions after poll.
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

    logSignalingStage("host_start", "session_created", {
      command_id: cmd.id,
      game_id: enrichedPayload.game_id as string,
      host_peer_token: hostPeerToken,
      session_id: newSession.id,
      status: "spawning",
      worker_token: workerToken,
    });
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

  // ── Long-poll: if this is a start_game or sdp_offer with SDP, hold the
  //     response open until gv-server processes the command and sends the
  //     answer back via the notify endpoint.  Eliminates browser-side polling.
  if ((body.type === CMD_START_GAME || body.type === CMD_SDP_OFFER) && enrichedPayload.sdp) {
    const answerFlow: SignalingFlow = body.type === CMD_SDP_OFFER
      ? (typeof enrichedPayload.peer_token === "string" || typeof enrichedPayload.room_token === "string" ? "guest_offer" : "host_reconnect")
      : "host_start";
    logSignalingStage(answerFlow, "waiting_for_sdp_answer", {
      command_id: cmd.id,
      game_id: typeof enrichedPayload.game_id === "string" ? enrichedPayload.game_id : undefined,
      worker_token: workerToken,
    });
    try {
      const sdpAnswer = await waitForSdpAnswer(cmd.id);
      logSignalingStage(answerFlow, "sdp_answer_resolved", {
        command_id: cmd.id,
        game_id: typeof enrichedPayload.game_id === "string" ? enrichedPayload.game_id : undefined,
        sdp_answer_length: sdpAnswer.length,
      });
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
      logSignalingStage(answerFlow, "sdp_answer_wait_failed", {
        command_id: cmd.id,
        error: err?.message || "SDP answer timed out",
        game_id: typeof enrichedPayload.game_id === "string" ? enrichedPayload.game_id : undefined,
      });
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
