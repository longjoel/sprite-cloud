import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { commands, sessions } from "@/lib/db/schema";
import { ACTIVE_SESSION_STATES } from "@/lib/constants";
import { applyRateLimit } from "@/lib/rate-limit";

const POLL_RATE_LIMIT = 180;

interface PollBody {
  server_id?: unknown;
  worker_token?: unknown;
}

interface NotifyRow {
  sessionId: string;
  workerUrl: string | null;
  gameId: string | null;
  status: string | null;
  sdpAnswer: string | null;
  roomToken: string | null;
  hostToken?: string | null;
  cmdResult: unknown;
}

function processRow(row: NotifyRow | undefined): NextResponse {
  if (row?.cmdResult && typeof row.cmdResult === "object" && (row.cmdResult as Record<string, unknown>).error) {
    const result = row.cmdResult as Record<string, unknown>;
    return NextResponse.json({ error: result.error, message: result.message || undefined });
  }
  if (!row || !row.workerUrl) {
    return NextResponse.json({ worker_url: null });
  }
  if (!row.status || !ACTIVE_SESSION_STATES.has(row.status as never)) {
    return NextResponse.json({ error: "session is not active" }, { status: 410 });
  }
  return NextResponse.json({
    session_id: row.sessionId,
    worker_url: row.workerUrl,
    game_id: row.gameId,
    status: row.status,
    sdp_answer: row.sdpAnswer ?? null,
    room_token: row.roomToken ?? null,
  });
}

async function pollNotify(serverId: string, workerToken: string) {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      workerUrl: sessions.workerUrl,
      gameId: sessions.gameId,
      status: sessions.status,
      sdpAnswer: sessions.sdpAnswer,
      roomToken: sessions.roomToken,
      cmdResult: commands.result,
    })
    .from(sessions)
    .innerJoin(commands, eq(commands.id, sessions.commandId))
    .where(and(eq(sessions.serverId, serverId), eq(commands.serverId, serverId), eq(commands.workerToken, workerToken)))
    .orderBy(desc(sessions.createdAt))
    .limit(1);

  if (row) return processRow(row);

  const [cmd] = await db
    .select({
      serverId: commands.serverId,
      payload: commands.payload,
      sdpAnswer: commands.sdpAnswer,
      result: commands.result,
    })
    .from(commands)
    .where(and(eq(commands.workerToken, workerToken), eq(commands.serverId, serverId)))
    .limit(1);
  if (!cmd || cmd.serverId !== serverId) return processRow(undefined);

  const payload = cmd.payload as Record<string, unknown> | null;
  const gameId = typeof payload?.game_id === "string" ? payload.game_id : undefined;
  if (!gameId) return processRow(undefined);

  const [fallback] = await db
    .select({
      sessionId: sessions.id,
      workerUrl: sessions.workerUrl,
      gameId: sessions.gameId,
      status: sessions.status,
      sdpAnswer: sessions.sdpAnswer,
      roomToken: sessions.roomToken,
      hostToken: sessions.hostToken,
      cmdResult: commands.result,
    })
    .from(sessions)
    .innerJoin(commands, eq(commands.id, sessions.commandId))
    .where(and(eq(sessions.serverId, serverId), eq(commands.serverId, serverId), eq(sessions.gameId, gameId)))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  if (!fallback) return processRow(undefined);

  const roomMatches = typeof payload?.room_token === "string" && payload.room_token === fallback.roomToken;
  const hostMatches = typeof payload?.host_token === "string" && payload.host_token === fallback.hostToken;
  if (!roomMatches && !hostMatches) return processRow(undefined);

  fallback.sdpAnswer = cmd.sdpAnswer || fallback.sdpAnswer;
  fallback.cmdResult = cmd.result;
  return processRow(fallback);
}

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(request, POLL_RATE_LIMIT);
  if (rateLimited) return rateLimited;

  let body: PollBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body.server_id !== "string" || !body.server_id) {
    return NextResponse.json({ error: "server_id required" }, { status: 400 });
  }
  if (typeof body.worker_token !== "string" || !body.worker_token) {
    return NextResponse.json({ error: "worker_token required" }, { status: 400 });
  }

  const response = await pollNotify(body.server_id, body.worker_token);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
