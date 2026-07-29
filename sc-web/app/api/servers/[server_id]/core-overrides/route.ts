import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { servers, serverMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function validCsrf(request: NextRequest): boolean {
  const header = request.headers.get("x-csrf-token");
  return Boolean(header && header === cookieValue(request.headers.get("cookie"), "sc_csrf_token"));
}

// GET /api/servers/[server_id]/core-overrides — read current overrides
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const { server_id } = await params;

  // Configuration and diagnostics remain administrator-only.
  const [member] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, server_id),
        eq(serverMembers.userId, session.user.id),
      ),
    )
    .limit(1);

  if (member?.role !== "admin") {
    return NextResponse.json({ error: "administrator access required" }, { status: 403 });
  }

  const [server] = await db
    .select({ metadata: servers.metadata })
    .from(servers)
    .where(eq(servers.id, server_id))
    .limit(1);

  const meta = (server?.metadata || {}) as Record<string, unknown>;
  const overrides = (meta.core_overrides as Record<string, string>) || {};

  return NextResponse.json({ overrides });
}

// PUT /api/servers/[server_id]/core-overrides — update overrides
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const { server_id } = await params;

  // Configuration mutations remain administrator-only.
  const [member] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, server_id),
        eq(serverMembers.userId, session.user.id),
      ),
    )
    .limit(1);

  if (member?.role !== "admin") {
    return NextResponse.json({ error: "administrator access required" }, { status: 403 });
  }
  if (!validCsrf(req)) {
    return NextResponse.json({ error: "invalid csrf token" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const overrides = body?.overrides;
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    return NextResponse.json({ error: "overrides must be an object" }, { status: 400 });
  }

  // Validate values are strings
  for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (typeof v !== "string" || !v.endsWith(".so")) {
      return NextResponse.json(
        { error: `invalid core for "${k}": must be a .so filename` },
        { status: 400 },
      );
    }
  }

  // Read current metadata
  const [server] = await db
    .select({ metadata: servers.metadata })
    .from(servers)
    .where(eq(servers.id, server_id))
    .limit(1);

  const currentMeta = (server?.metadata || {}) as Record<string, unknown>;
  const newMeta = { ...currentMeta, core_overrides: overrides };

  await db
    .update(servers)
    .set({ metadata: newMeta })
    .where(eq(servers.id, server_id));

  return NextResponse.json({ overrides });
}
