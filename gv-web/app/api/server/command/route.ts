import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { commands, gameFiles, games, serverMembers, servers } from "@/lib/db/schema";
import { CMD_SDP_OFFER, CMD_START_GAME, CMD_STOP_GAME, CMD_BROWSE_FILES, CMD_SCAN_PATHS } from "@/lib/constants";
import { and, eq } from "drizzle-orm";
import crypto from "crypto";

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
      if (!hasOnlyKeys(payload, ["game_id", "host_token"])) return { ok: false, error: "payload has unexpected fields" };
      if (typeof payload.game_id !== "string" || payload.game_id.length === 0) return { ok: false, error: "payload.game_id required" };
      if (payload.host_token !== undefined && typeof payload.host_token !== "string") return { ok: false, error: "payload.host_token must be string" };
      return { ok: true, payload };
    }
    case CMD_STOP_GAME: {
      if (!hasOnlyKeys(payload, ["game_id"])) return { ok: false, error: "payload has unexpected fields" };
      if (typeof payload.game_id !== "string" || payload.game_id.length === 0) return { ok: false, error: "payload.game_id required" };
      return { ok: true, payload };
    }
    case CMD_SDP_OFFER: {
      if (!hasOnlyKeys(payload, ["game_id", "sdp", "host_token"])) return { ok: false, error: "payload has unexpected fields" };
      if (typeof payload.game_id !== "string" || payload.game_id.length === 0) return { ok: false, error: "payload.game_id required" };
      if (typeof payload.sdp !== "string" || payload.sdp.length === 0) return { ok: false, error: "payload.sdp required" };
      if (payload.host_token !== undefined && typeof payload.host_token !== "string") return { ok: false, error: "payload.host_token must be string" };
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
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  if (!validateCsrf(request)) {
    return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });
  }

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

  // Validate server_id
  if (!body.server_id) {
    return NextResponse.json({ error: "server_id required" }, { status: 400 });
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
            eq(gameFiles.serverId, body.server_id),
          ),
        )
        .limit(1);

      if (gameFile) {
        enrichedPayload = {
          ...sp,
          rom_path: gameFile.romPath,
          platform: gameFile.platform,
        };
      } else {
        return NextResponse.json(
          { error: `game ${sp.game_id} not found on this server` },
          { status: 404 },
        );
      }
    }
  }

  // Insert command
  const [cmd] = await db
    .insert(commands)
    .values({
      serverId: body.server_id,
      type: body.type,
      payload: enrichedPayload,
      workerToken,
    })
    .returning({ id: commands.id });

  return NextResponse.json({ id: cmd.id, worker_token: workerToken }, { status: 201 });
}
