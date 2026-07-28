import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { inviteCodes } from "@/lib/db/schema";
import { requireServerAdmin } from "@/lib/invites";

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ server_id: string; invite_id: string }> },
) {
  const { server_id, invite_id } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!await requireServerAdmin(session.user.id, server_id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const csrf = request.headers.get("x-csrf-token");
  if (!csrf || csrf !== cookieValue(request.headers.get("cookie"), "sc_csrf_token")) {
    return NextResponse.json({ error: "invalid csrf token" }, { status: 403 });
  }

  const [invite] = await db
    .update(inviteCodes)
    .set({ revokedAt: new Date() })
    .where(and(eq(inviteCodes.id, invite_id), eq(inviteCodes.serverId, server_id)))
    .returning({ id: inviteCodes.id });

  if (!invite) return NextResponse.json({ error: "invite not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
