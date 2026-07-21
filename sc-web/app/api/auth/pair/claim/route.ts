import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { pairingCodes, serverMembers, serverRomRoots, servers } from "@/lib/db/schema";
import { generateApiKey, hashApiKey } from "@/lib/server-auth";
import { eq, and } from "drizzle-orm";
import { applyRateLimit } from "@/lib/rate-limit";

const PAIR_RATE_LIMIT = 10; // requests per minute per IP

// POST /api/auth/pair/claim — sc-server claims a pairing code, gets an API key.
// Optionally reports its ROM root directories for game discovery.
export async function POST(request: NextRequest) {
  // Rate limiting — 10 req/min per IP
  const rateLimited = applyRateLimit(request, PAIR_RATE_LIMIT);
  if (rateLimited) return rateLimited;

  let body: { code: string; server_name?: string; rom_roots?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const raw = (body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 8) {
    return NextResponse.json({ error: "invalid code format" }, { status: 400 });
  }

  // Insert dash for DB lookup: MKQZAPLE → MKQZ-APLE
  const code = raw.slice(0, 4) + "-" + raw.slice(4);

  // Look up the code
  const results = await db
    .select()
    .from(pairingCodes)
    .where(and(eq(pairingCodes.code, code), eq(pairingCodes.status, "pending")));

  if (results.length === 0) {
    return NextResponse.json({ error: "invalid or expired code" }, { status: 404 });
  }

  const record = results[0];

  // Check expiry
  if (new Date(record.expiresAt) < new Date()) {
    await db
      .update(pairingCodes)
      .set({ status: "expired" })
      .where(eq(pairingCodes.code, code));
    return NextResponse.json({ error: "code expired" }, { status: 410 });
  }

  // Generate API key and create or reuse server.
  // Idempotent pairing: if a server with the same name already exists for
  // this user, rotate the API key instead of creating a new server.
  // This prevents data orphans when a user re-pairs after a config reset.
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const serverName = (body.server_name || "sc-server").trim() || "sc-server";

  // Check for existing server by user + name
  const [existing] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(
      and(eq(servers.userId, record.userId), eq(servers.name, serverName))
    )
    .limit(1);

  let serverId: string;

  if (existing) {
    // Re-pair: rotate the API key on the existing server
    await db
      .update(servers)
      .set({ apiKeyHash, lastSeenAt: new Date() })
      .where(eq(servers.id, existing.id));
    serverId = existing.id;
  } else {
    // First pair: create a new server
    const [server] = await db
      .insert(servers)
      .values({
        userId: record.userId,
        apiKeyHash,
        name: serverName,
      })
      .returning({ id: servers.id });

    if (!server) {
      return NextResponse.json({ error: "failed to create server" }, { status: 500 });
    }
    serverId = server.id;
  }

  // Mark code as claimed
  await db
    .update(pairingCodes)
    .set({ status: "claimed", claimedAt: new Date() })
    .where(eq(pairingCodes.code, code));

  // Auto-add the pairing user as admin member (first pair only).
  // On re-pair, the user is already a member.
  if (!existing) {
    await db.insert(serverMembers).values({
      serverId,
      userId: record.userId,
      role: "admin",
    });
  }

  // Upsert ROM roots if the server reported them.
  // Remove old roots not in the new list; insert new ones.
  const romRoots: string[] = body.rom_roots ?? [];
  if (romRoots.length > 0) {
    // Delete roots no longer reported
    await db
      .delete(serverRomRoots)
      .where(eq(serverRomRoots.serverId, serverId));

    // Insert the current set
    await db.insert(serverRomRoots).values(
      romRoots.map((path) => ({
        serverId,
        path,
      })),
    );
  }
  // If rom_roots is absent or empty, preserve existing roots (backward compat).

  return NextResponse.json({
    server_id: serverId,
    api_key: apiKey,
  });
}
