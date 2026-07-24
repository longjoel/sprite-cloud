import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { commands } from "@/lib/db/schema";
import { verifyBearerToken } from "@/lib/server-auth";
import { and, eq } from "drizzle-orm";
import { STATUS_COMPLETED, STATUS_LEASED } from "@/lib/constants";

// sc-server reports transient command results only. Library scan output is
// intentionally never imported into sc-web.
export async function POST(request: NextRequest) {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { command_id?: string; lease_token?: string; result?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.command_id || !body.lease_token || body.result === undefined) {
    return NextResponse.json(
      { error: "command_id, lease_token, and result required" },
      { status: 400 },
    );
  }

  const [updated] = await db
    .update(commands)
    .set({ result: body.result, status: STATUS_COMPLETED, completedAt: new Date(), lastError: null })
    .where(and(
      eq(commands.id, body.command_id),
      eq(commands.serverId, server.id),
      eq(commands.status, STATUS_LEASED),
      eq(commands.leaseToken, body.lease_token),
    ))
    .returning({ id: commands.id });

  if (!updated) return NextResponse.json({ error: "command not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
