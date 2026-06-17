import { NextResponse } from "next/server";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// GET /api/auth/verify — gv-server verifies its API key is valid
// POST /api/auth/verify — same, but also reports non-secret server metadata
export async function GET(request: Request) {
  return handleVerify(request, null);
}

export async function POST(request: Request) {
  let metadata: Record<string, unknown> | null = null;
  try {
    const body = await request.json();
    if (body && typeof body.metadata === "object" && !Array.isArray(body.metadata)) {
      metadata = body.metadata as Record<string, unknown>;
    }
  } catch {
    // No JSON body or unparseable — proceed with verify-only
  }

  return handleVerify(request, metadata);
}

async function handleVerify(
  request: Request,
  metadata: Record<string, unknown> | null,
) {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse();

  // Store metadata if provided and non-empty
  if (metadata && Object.keys(metadata).length > 0) {
    // Strip any secrets before storing (defense in depth)
    const safe = sanitizeMetadata(metadata);
    await db
      .update(servers)
      .set({ lastSeenAt: new Date(), metadata: safe })
      .where(eq(servers.id, server.id));
  }

  return NextResponse.json({
    server_id: server.id,
    user_id: server.userId,
    name: server.name,
  });
}

// Strips known secret fields from metadata (defense in depth —
// the server should never send these, but we validate server-side)
const SECRET_KEYS = new Set([
  "turn_password",
  "turn_credential",
  "turn_secret",
  "api_key",
  "token",
  "password",
  "secret",
]);

function sanitizeMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SECRET_KEYS.has(key)) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      out[key] = sanitizeMetadata(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}
