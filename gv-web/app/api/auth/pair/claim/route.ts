import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { pairingCodes, serverMembers, servers } from "@/lib/db/schema";
import { generateApiKey, hashApiKey } from "@/lib/server-auth";
import { eq, and } from "drizzle-orm";

// POST /api/auth/pair/claim — gv-server claims a pairing code, gets an API key
export async function POST(request: NextRequest) {
  let body: { code: string };
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

  // Generate API key and create server
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  const [server] = await db
    .insert(servers)
    .values({
      userId: record.userId,
      apiKeyHash,
      name: "gv-server",
    })
    .returning({ id: servers.id });

  if (!server) {
    return NextResponse.json({ error: "failed to create server" }, { status: 500 });
  }

  // Mark code as claimed
  await db
    .update(pairingCodes)
    .set({ status: "claimed", claimedAt: new Date() })
    .where(eq(pairingCodes.code, code));

  // Auto-add the pairing user as admin member
  await db.insert(serverMembers).values({
    serverId: server.id,
    userId: record.userId,
    role: "admin",
  });

  return NextResponse.json({
    server_id: server.id,
    api_key: apiKey,
  });
}
