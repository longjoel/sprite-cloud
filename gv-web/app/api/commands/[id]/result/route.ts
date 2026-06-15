import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { commands, serverMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

// ── GET /api/commands/[id]/result ──────────────────────────────────────
//
// Browser polls for a command's result. Auth: session cookie.
// Security: only members of the server the command targets can read it.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const { id } = await params;

  // Verify the caller is a member of the command's server
  const [cmd] = await db
    .select({ result: commands.result })
    .from(commands)
    .innerJoin(
      serverMembers,
      and(
        eq(serverMembers.serverId, commands.serverId),
        eq(serverMembers.userId, session.user.id),
      ),
    )
    .where(eq(commands.id, id))
    .limit(1);

  if (!cmd) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ result: cmd.result });
}
