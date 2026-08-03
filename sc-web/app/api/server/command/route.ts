import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { commands, peerTokens, serverMembers, servers, sessions, shortCodes } from "@/lib/db/schema";
import { ACTIVE_SESSION_STATES, CMD_SDP_OFFER, CMD_START_GAME, CMD_STOP_GAME, SESSION_CONNECTED, SESSION_PLAYING, SESSION_READY, SESSION_SPAWNING, SESSION_STATE_TIMEOUT_MS, STATUS_PENDING } from "@/lib/constants";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { applyRateLimit } from "@/lib/rate-limit";
import { recordLaunchEvent } from "@/lib/launch-events";
import { waitForSdpAnswer } from "@/lib/pending-sdp";
import { classifyCommandFlow, logSignalingStage, type SignalingFlow } from "@/lib/signaling";
import { verifyBearerToken } from "@/lib/server-auth";
import crypto from "crypto";
import { hostCapabilities, type PlayerCapabilities } from "@/lib/capabilities";

const COMMAND_RATE_LIMIT = 30; // requests per minute per IP

// ── Validation ─────────────────────────────────────────────────────────

const VALID_TYPES = new Set<string>([CMD_START_GAME, CMD_STOP_GAME, CMD_SDP_OFFER]);
const RECONNECT_TRANSIENT_STATES = [SESSION_SPAWNING, SESSION_READY, SESSION_CONNECTED] as const;

function isRoomCapability(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function canExecute(capabilities: PlayerCapabilities, commandType: string): boolean {
  switch (commandType) {
    case CMD_START_GAME: return capabilities.canStart;
    case CMD_STOP_GAME: return capabilities.canStop;
    case CMD_SDP_OFFER: return true; // all roles can send SDP
    default: return false;
  }
}

async function resolveShortCodeHostUser(
  serverId: string,
  gameId: string,
  hostToken: string,
  authHeader: string | null,
): Promise<string | null> {
  const [shortCode] = await db
    .select({ code: shortCodes.code, createdBy: shortCodes.createdBy })
    .from(shortCodes)
    .where(and(
      eq(shortCodes.serverId, serverId),
      eq(shortCodes.gameId, gameId),
      eq(shortCodes.hostToken, hostToken),
    ))
    .limit(1);
  if (!shortCode) return null;

  if (shortCode.createdBy) {
    const [member] = await db
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .where(and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, shortCode.createdBy),
      ))
      .limit(1);
    return member?.userId ?? null;
  }

  // Creator-less legacy codes cannot establish a new user identity. They may
  // recover only the owner of an already-active exact-token session so stop
  // and reconnect remain safe; a fresh legacy start fails closed.
  const [legacySession] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(
      eq(sessions.serverId, serverId),
      eq(sessions.gameId, gameId),
      eq(sessions.hostToken, hostToken),
      inArray(sessions.status, [...ACTIVE_SESSION_STATES]),
    ))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  if (legacySession?.userId) return legacySession.userId;

  // LAN proxy authority: when the paired server itself proxies start_game
  // (server bearer matching this server), the server is the host authority for
  // its own LAN — mirroring the resolve route, which grants host capability to
  // the paired server bearer for codes it minted. This keeps the LAN player
  // working when the LAN library (or persistUrl) created the code via the
  // server-bearer proxy path (createdBy = NULL) instead of a browser session.
  const bearerServer = await verifyBearerToken(authHeader);
  if (bearerServer && bearerServer.id === serverId) {
    return bearerServer.userId ?? null;
  }

  return null;
}

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
  const cookieToken = cookieValue(request.headers.get("cookie"), "sc_csrf_token");
  return !!headerToken && !!cookieToken && headerToken === cookieToken;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isOpaqueGameId(value: unknown): value is string {
  return typeof value === "string" && /^local_[0-9a-f]{32}$/.test(value);
}

function validatePayload(type: string, payload: unknown): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  if (!isPlainRecord(payload)) {
    return { ok: false, error: "payload must be an object" };
  }

  switch (type) {
    case CMD_START_GAME: {
      if (!hasOnlyKeys(payload, ["game_id", "host_token", "sdp", "lan"])) return { ok: false, error: "payload has unexpected fields" };
      if (!isOpaqueGameId(payload.game_id)) return { ok: false, error: "opaque payload.game_id required" };
      if (payload.host_token !== undefined && typeof payload.host_token !== "string") return { ok: false, error: "payload.host_token must be string" };
      if (payload.sdp !== undefined && typeof payload.sdp !== "string") return { ok: false, error: "payload.sdp must be string" };
      if (payload.lan !== undefined && typeof payload.lan !== "boolean") return { ok: false, error: "payload.lan must be boolean" };
      return { ok: true, payload };
    }
    case CMD_STOP_GAME: {
      if (!hasOnlyKeys(payload, ["game_id", "host_token"])) return { ok: false, error: "payload has unexpected fields" };
      if (!isOpaqueGameId(payload.game_id)) return { ok: false, error: "opaque payload.game_id required" };
      if (payload.host_token !== undefined && typeof payload.host_token !== "string") return { ok: false, error: "payload.host_token must be string" };
      return { ok: true, payload };
    }
    case CMD_SDP_OFFER: {
      if (!hasOnlyKeys(payload, ["game_id", "sdp", "host_token", "room_token", "peer_token", "lan"])) return { ok: false, error: "payload has unexpected fields" };
      if (!isOpaqueGameId(payload.game_id)) return { ok: false, error: "opaque payload.game_id required" };
      if (typeof payload.sdp !== "string" || payload.sdp.length === 0) return { ok: false, error: "payload.sdp required" };
      if (payload.host_token !== undefined && typeof payload.host_token !== "string") return { ok: false, error: "payload.host_token must be string" };
      if (payload.room_token !== undefined && typeof payload.room_token !== "string") return { ok: false, error: "payload.room_token must be string" };
      if (payload.peer_token !== undefined && typeof payload.peer_token !== "string") return { ok: false, error: "payload.peer_token must be string" };
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

  let body: CommandBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  let serverId: string | undefined;

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
  let authenticatedPeer: { role: string; seat: number | null; sessionId: string } | null = null;

  // ── LAN host start via short-code bearer token ─────────────────────
  // The embedded LAN player runs on http://<server-ip>:8787, so it cannot
  // send gateway auth cookies. The library page creates a short-code row,
  // then sends host_token only in the LAN URL fragment. Accept start_game
  // without cookies only when that host_token matches the short-code row for
  // the selected server/game and the caller explicitly marks lan=true.
  const lanStartPayload = payloadResult.payload;
  if (
    isRoomCapability(lanStartPayload.host_token)
    && (
      (body.type === CMD_START_GAME && lanStartPayload.lan === true)
      || body.type === CMD_STOP_GAME
      || body.type === CMD_SDP_OFFER
    )
  ) {
    return NextResponse.json({ error: "room capability cannot authorize host actions" }, { status: 403 });
  }
  if (
    body.type === CMD_START_GAME &&
    lanStartPayload.lan === true &&
    typeof lanStartPayload.host_token === "string" &&
    typeof lanStartPayload.game_id === "string"
  ) {
    const ownerUserId = await resolveShortCodeHostUser(
      body.server_id,
      lanStartPayload.game_id,
      lanStartPayload.host_token,
      request.headers.get("authorization"),
    );
    if (!ownerUserId) {
      return NextResponse.json({ error: "invalid LAN launch token" }, { status: 403 });
    }
    lanStartUserId = ownerUserId;
    serverId = body.server_id;
  } else if (
    body.type === CMD_STOP_GAME
    && typeof lanStartPayload.host_token === "string"
    && typeof lanStartPayload.game_id === "string"
  ) {
    const ownerUserId = await resolveShortCodeHostUser(
      body.server_id,
      lanStartPayload.game_id,
      lanStartPayload.host_token,
      request.headers.get("authorization"),
    );
    if (!ownerUserId) {
      return NextResponse.json({ error: "invalid LAN stop token" }, { status: 403 });
    }
    lanStartUserId = ownerUserId;
    serverId = body.server_id;
  } else if (body.type === CMD_SDP_OFFER) {
    const sdpPayload = body.payload as Record<string, unknown> | undefined;
    const roomToken = sdpPayload?.room_token as string | undefined;
    const peerToken = sdpPayload?.peer_token as string | undefined;
    const hostToken = sdpPayload?.host_token as string | undefined;
    console.log("[COMMAND] sdp_offer received — room_token:", !!roomToken, "peer_token:", !!peerToken, "host_token:", !!hostToken);
    const carriesGuestCapability = !!roomToken || !!peerToken;
    if (!carriesGuestCapability && hostToken && typeof sdpPayload?.game_id === "string") {
      const ownerUserId = await resolveShortCodeHostUser(
        body.server_id,
        sdpPayload.game_id,
        hostToken,
        request.headers.get("authorization"),
      );
      if (ownerUserId) {
        lanStartUserId = ownerUserId;
        serverId = body.server_id;
      }
    }
    if (carriesGuestCapability) {
      if (!roomToken || !peerToken) {
        return NextResponse.json({ error: "room_token and peer_token required for guest SDP" }, { status: 403 });
      }
      // Resolve room_token → active session → server_id
      const [roomSession] = await db
        .select({ id: sessions.id, serverId: sessions.serverId, gameId: sessions.gameId, status: sessions.status })
        .from(sessions)
        .where(eq(sessions.roomToken, roomToken))
        .limit(1);

      if (!roomSession) {
        return NextResponse.json({ error: "invalid room_token" }, { status: 403 });
      }
      if (roomSession.serverId !== body.server_id || roomSession.gameId !== sdpPayload?.game_id) {
        return NextResponse.json({ error: "room_token does not match server or game" }, { status: 403 });
      }
      if (!["spawning", "ready", "connected", "playing"].includes(roomSession.status)) {
        return NextResponse.json({ error: "session ended" }, { status: 410 });
      }
      if (!peerToken) {
        return NextResponse.json({ error: "peer_token required for guest SDP" }, { status: 403 });
      }
      const [peer] = await db
        .select({ role: peerTokens.role, seat: peerTokens.seat })
        .from(peerTokens)
        .where(and(eq(peerTokens.token, peerToken), eq(peerTokens.sessionId, roomSession.id)))
        .limit(1);
      if (!peer) {
        return NextResponse.json({ error: "peer_token does not match room session" }, { status: 403 });
      }
      authenticatedPeer = { ...peer, sessionId: roomSession.id };
      serverId = roomSession.serverId!;
      // Guest auth successful — skip session + CSRF + membership checks
    } else if (!serverId) {
      // No host_token or room_token — fall through to normal auth
      serverId = body.server_id;
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
      // Host SDP reconnects require host capability (admin).
      // Guest SDP offers are already handled in the guest branch above.
      if (membership.role !== "admin") {
        return NextResponse.json({ error: "host authority required" }, { status: 403 });
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
    // Enrolled members may start only the launch represented by a short code
    // they created. Other host commands remain admin-only until they prove
    // ownership of an existing session below.
    if (membership.role !== "admin") {
      if (
        body.type !== CMD_START_GAME
        || typeof payloadResult.payload.host_token !== "string"
        || typeof payloadResult.payload.game_id !== "string"
      ) {
        return NextResponse.json({ error: "host authority required" }, { status: 403 });
      }
      const [ownedLaunch] = await db
        .select({ createdBy: shortCodes.createdBy })
        .from(shortCodes)
        .where(and(
          eq(shortCodes.serverId, body.server_id),
          eq(shortCodes.gameId, payloadResult.payload.game_id),
          eq(shortCodes.hostToken, payloadResult.payload.host_token),
          eq(shortCodes.createdBy, session.user.id),
        ))
        .limit(1);
      if (!ownedLaunch) {
        return NextResponse.json({ error: "host authority required" }, { status: 403 });
      }
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

  let enrichedPayload: Record<string, unknown> = payloadResult.payload;

  if (body.type === CMD_START_GAME) {
    const sp = payloadResult.payload;
    if (sp.lan === true) {
      console.info("[COMMAND] start_game received explicit lan=true hint from caller — preserving explicit transport hint");
    } else {
      console.info("[COMMAND] start_game using deterministic transport selection — no gateway-side LAN auto-detection");
    }
  } else if (body.type === CMD_STOP_GAME) {
    const [targetSession] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(
        eq(sessions.serverId, serverId),
        eq(sessions.gameId, payloadResult.payload.game_id as string),
        typeof payloadResult.payload.host_token === "string"
          ? eq(sessions.hostToken, payloadResult.payload.host_token)
          : undefined,
        inArray(sessions.status, [...ACTIVE_SESSION_STATES]),
      ))
      .orderBy(desc(sessions.createdAt))
      .limit(1);
    if (!targetSession) {
      return NextResponse.json({ error: "active session not found" }, { status: 409 });
    }
    enrichedPayload = { ...payloadResult.payload, session_id: targetSession.id };
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
    if (authenticatedPeer) {
      enrichedPayload = {
        ...sp,
        peer_role: authenticatedPeer.role,
        peer_seat: authenticatedPeer.seat,
        session_id: authenticatedPeer.sessionId,
      };
      logSignalingStage("guest_offer", "payload_enriched", {
        game_id: sp.game_id,
        peer_role: authenticatedPeer.role,
        peer_seat: authenticatedPeer.seat,
      });
    } else if (typeof sp.host_token === "string") {
      const [hostSession] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(
          eq(sessions.serverId, serverId),
          eq(sessions.gameId, sp.game_id as string),
          eq(sessions.hostToken, sp.host_token),
          inArray(sessions.status, [...ACTIVE_SESSION_STATES]),
        ))
        .orderBy(desc(sessions.createdAt))
        .limit(1);
      if (!hostSession) {
        return NextResponse.json({ error: "active host session not found" }, { status: 409 });
      }
      enrichedPayload = { ...sp, session_id: hostSession.id };
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
      // start_game remains invisible to server polling until its exact session,
      // peer capability, and final payload have been committed below.
      status: body.type === CMD_START_GAME ? "preparing" : STATUS_PENDING,
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
      has_worker_token: true,
    });
  }

  await recordLaunchEvent({
    commandId: cmd.id,
    serverId,
    gameId: typeof enrichedPayload.game_id === "string" ? enrichedPayload.game_id : null,
    source: "sc-web",
    event: "command_inserted",
    detail: { command_type: body.type },
  });

  // For sdp_offer commands, also record the offer sent event
  if (body.type === CMD_SDP_OFFER) {
    await recordLaunchEvent({
      commandId: cmd.id,
      serverId,
      gameId: typeof enrichedPayload.game_id === "string" ? enrichedPayload.game_id : null,
      source: "sc-web",
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

      const [existing] = await db
        .select({ id: sessions.id, commandId: sessions.commandId, roomToken: sessions.roomToken, status: sessions.status })
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, uid),
            eq(sessions.serverId, serverId),
            eq(sessions.gameId, enrichedPayload.game_id as string),
            or(
              eq(sessions.status, SESSION_PLAYING),
              and(
                inArray(sessions.status, [...RECONNECT_TRANSIENT_STATES]),
                gte(sessions.stateEnteredAt, reconnectCutoff),
              ),
            ),
          ),
        )
        .orderBy(desc(sessions.createdAt))
        .limit(1);

      if (existing) {
        // Invariant: host reconnect reuses the existing host session in-place.
        // It MUST carry host_token only — never peer_token — so sc-server stays on
        // the host reconnection path instead of the guest-PC creation path.
        logSignalingStage("host_reconnect", "reuse_existing_session", {
          command_id: cmd.id,
          existing_command_id: existing.commandId,
          game_id: enrichedPayload.game_id as string,
          session_id: existing.id,
          session_status: existing.status,
        });

        // NOTE: we do NOT include peer_token — this is a HOST reconnect,
        // not a guest join. Including peer_token would cause sc-server to
        // route the SDP exchange through handle_guest_sdp (building a new
        // PC with host track copies) instead of handle_sdp_offer's host
        // reconnection path (swapping the session PC in place).
        // Issue a new host peer_token for this reconnect
        hostPeerToken = crypto.randomBytes(16).toString("hex");
        await db.insert(peerTokens).values({
          sessionId: existing.id,
          token: hostPeerToken,
          seat: 0,
          role: "host",
        });

        // Publish the fully converted reconnect command only after its peer
        // capability exists. Server polling ignores the preparing state.
        await db.update(commands).set({
          type: CMD_SDP_OFFER,
          payload: {
            game_id: enrichedPayload.game_id,
            session_id: existing.id,
            sdp: enrichedPayload.sdp,
            host_token: hostToken,
          },
          status: STATUS_PENDING,
        }).where(eq(commands.id, cmd.id));

        await recordLaunchEvent({
          commandId: cmd.id,
          sessionId: existing.id,
          serverId,
          gameId: enrichedPayload.game_id as string,
          source: "sc-web",
          event: "host_reconnect",
          detail: {},
        });

        // Return immediately — no need to long-poll for SDP answer on reconnect
        logSignalingStage("host_reconnect", "response_ready", {
          command_id: cmd.id,
          has_host_peer_token: true,
          session_id: existing.id,
          has_worker_token: true,
        });
        return NextResponse.json(
          { id: cmd.id, worker_token: workerToken, host_peer_token: hostPeerToken },
          { status: 201 },
        );
      }
    }

    const launchLockKey = `${serverId}:${uid}`;
    const prepared = await db.transaction(async (tx) => {
      // Serialize all launches from the same host identity before reading or
      // ending prior sessions. The lock is released automatically on commit.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${launchLockKey}, 0))`);

      // End prior sessions for this stable server/owner identity, create the new generation and peer
      // capability, and publish the prepared command as one atomic unit.
      const victims = await tx
        .select({
          id: sessions.id,
          gameId: sessions.gameId,
          commandId: sessions.commandId,
        })
        .from(sessions)
        .where(and(
          eq(sessions.userId, uid),
          eq(sessions.serverId, serverId),
          inArray(sessions.status, [...ACTIVE_SESSION_STATES]),
        ));
      for (const victim of victims) {
        if (victim.commandId) {
          await tx
            .update(commands)
            .set({ status: "cancelled", leaseToken: null, leasedAt: null, leaseExpiresAt: null })
            .where(and(
              eq(commands.id, victim.commandId),
              inArray(commands.status, ["preparing", STATUS_PENDING, "leased"]),
            ));
        }
        await tx.insert(commands).values({
          serverId,
          type: CMD_STOP_GAME,
          payload: { game_id: victim.gameId, session_id: victim.id },
          workerToken: crypto.randomBytes(16).toString("hex"),
          status: STATUS_PENDING,
        });
        await tx
          .update(sessions)
          .set({ status: "ended", endedAt: new Date(), roomToken: null })
          .where(eq(sessions.id, victim.id));
      }

      const [newSession] = await tx.insert(sessions).values({
        userId: uid,
        serverId,
        gameId: enrichedPayload.game_id as string,
        commandId: cmd.id,
        hostToken: hostToken ?? null,
        roomToken: null,
        status: "spawning",
        generation: 1,
        stateEnteredAt: new Date(),
      }).returning({ id: sessions.id });

      const newHostPeerToken = crypto.randomBytes(16).toString("hex");
      await tx.insert(peerTokens).values({
        sessionId: newSession.id,
        token: newHostPeerToken,
        seat: 0,
        role: "host",
      });
      const finalPayload = {
        ...enrichedPayload,
        session_id: newSession.id,
        peer_tokens: [{ token: newHostPeerToken, seat: 0, role: "host" }],
      };
      await tx
        .update(commands)
        .set({ payload: finalPayload, status: STATUS_PENDING })
        .where(eq(commands.id, cmd.id));
      return { newSession, newHostPeerToken, finalPayload };
    });
    hostPeerToken = prepared.newHostPeerToken;
    enrichedPayload = prepared.finalPayload;

    logSignalingStage("host_start", "session_created", {
      command_id: cmd.id,
      game_id: enrichedPayload.game_id as string,
      has_host_peer_token: true,
      session_id: prepared.newSession.id,
      status: "spawning",
      has_worker_token: true,
    });
  }

  // ── Long-poll: if this is a start_game or sdp_offer with SDP, hold the
  //     response open until sc-server processes the command and sends the
  //     answer back via the notify endpoint.  Eliminates browser-side polling.
  if ((body.type === CMD_START_GAME || body.type === CMD_SDP_OFFER) && enrichedPayload.sdp) {
    const answerFlow: SignalingFlow = body.type === CMD_SDP_OFFER
      ? (typeof enrichedPayload.peer_token === "string" || typeof enrichedPayload.room_token === "string" ? "guest_offer" : "host_reconnect")
      : "host_start";
    logSignalingStage(answerFlow, "waiting_for_sdp_answer", {
      command_id: cmd.id,
      game_id: typeof enrichedPayload.game_id === "string" ? enrichedPayload.game_id : undefined,
      has_worker_token: true,
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
