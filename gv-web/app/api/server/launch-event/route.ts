import { NextRequest, NextResponse } from "next/server";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import { recordLaunchEvent } from "@/lib/launch-events";

/**
 * POST /api/server/launch-event
 *
 * gv-server reports timeline milestones that gv-web cannot observe directly
 * (worker process start, ROM load begin/end, etc.).
 *
 * Body: { event: string, command_id?: string, game_id?: string, session_id?: string, detail?: object }
 */
export async function POST(request: NextRequest) {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse();

  let body: {
    event: string;
    command_id?: string;
    game_id?: string;
    session_id?: string;
    detail?: Record<string, unknown>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.event || typeof body.event !== "string") {
    return NextResponse.json({ error: "event required" }, { status: 400 });
  }

  await recordLaunchEvent({
    commandId: body.command_id ?? null,
    serverId: server.id,
    gameId: body.game_id ?? null,
    sessionId: body.session_id ?? null,
    source: "gv-server",
    event: body.event,
    detail: body.detail ?? {},
  });

  return NextResponse.json({ ok: true });
}
