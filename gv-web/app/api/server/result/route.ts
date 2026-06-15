import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { commands } from "@/lib/db/schema";
import { verifyBearerToken } from "@/lib/server-auth";
import { eq, and } from "drizzle-orm";

// ── POST /api/server/result ────────────────────────────────────────────
//
// gv-server reports the result of a completed command (e.g. browse_files
// file tree, scan_paths matches). Auth: Bearer token (API key).
// Security: only the server that owns the command can set its result.

export async function POST(request: NextRequest) {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { command_id?: string; result?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.command_id || body.result === undefined) {
    return NextResponse.json(
      { error: "command_id and result required" },
      { status: 400 },
    );
  }

  // Only update if the server owns this command
  const [updated] = await db
    .update(commands)
    .set({ result: body.result })
    .where(
      and(
        eq(commands.id, body.command_id),
        eq(commands.serverId, server.id),
      ),
    )
    .returning({ id: commands.id });

  if (!updated) {
    return NextResponse.json({ error: "command not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
