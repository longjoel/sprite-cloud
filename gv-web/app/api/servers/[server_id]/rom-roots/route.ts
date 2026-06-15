import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverRomRoots } from "@/lib/db/schema";
import { verifyBearerToken } from "@/lib/server-auth";
import { eq } from "drizzle-orm";

// GET /api/servers/:server_id/rom-roots — list ROM root paths for a server.
// Requires a valid server API key (Bearer token).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const { server_id } = await params;

  // Authenticate — any valid server API key suffices for listing
  const auth = await verifyBearerToken(request.headers.get("authorization"));
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const roots = await db
    .select({ path: serverRomRoots.path })
    .from(serverRomRoots)
    .where(eq(serverRomRoots.serverId, server_id));

  return NextResponse.json({
    server_id,
    rom_roots: roots.map((r) => r.path),
  });
}
