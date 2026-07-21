import { NextResponse } from "next/server";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import { db } from "@/lib/db";
import { servers, serverRomRoots } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// GET /api/auth/verify — sc-server verifies its API key is valid
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

    // Sync ROM roots to server_rom_roots table if reported.
    // This keeps roots in sync on every server startup, not just
    // at claim time — if a user changes GV_ROM_ROOTS and restarts,
    // the new roots are reflected without re-pairing.
    const romRoots = extractRomRoots(metadata);
    if (romRoots !== null) {
      // Delete roots no longer reported
      await db
        .delete(serverRomRoots)
        .where(eq(serverRomRoots.serverId, server.id));

      // Insert the current set
      if (romRoots.length > 0) {
        await db.insert(serverRomRoots).values(
          romRoots.map((path) => ({
            serverId: server.id,
            path,
          })),
        );
      }
    }
  }

  // Return core_overrides if stored in metadata
  const meta = (server.metadata || {}) as Record<string, unknown>;
  const coreOverrides = meta.core_overrides as Record<string, string> | undefined;

  return NextResponse.json({
    server_id: server.id,
    user_id: server.userId,
    name: server.name,
    ...(coreOverrides ? { core_overrides: coreOverrides } : {}),
  });
}

// Extract rom_roots from the nested metadata that sc-server sends:
// { metadata: { rom_roots: ["/path/one", "/path/two"] } }
function extractRomRoots(metadata: Record<string, unknown>): string[] | null {
  // sc-server wraps metadata in a "metadata" key
  const inner = metadata.metadata as Record<string, unknown> | undefined;
  const roots = (inner?.rom_roots ?? metadata.rom_roots) as unknown;
  if (Array.isArray(roots) && roots.every((r) => typeof r === "string")) {
    return roots as string[];
  }
  return null;
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
