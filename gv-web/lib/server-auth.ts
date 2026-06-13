import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { servers, serverMembers } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

// ── Pairing code generation ──────────────────────────────────────────

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusable chars
const CODE_LENGTH = 8;
const CODE_TTL_MINUTES = 5;

export function generatePairingCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  // Insert dash for readability: MKQZAPLE → MKQZ-APLE
  return code.slice(0, 4) + "-" + code.slice(4);
}

export function pairingCodeExpiresAt(): Date {
  return new Date(Date.now() + CODE_TTL_MINUTES * 60_000);
}

// ── API key generation ────────────────────────────────────────────────

export function generateApiKey(): string {
  const bytes = randomBytes(32);
  return "gvsk_" + bytes.toString("base64url");
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// ── Bearer token verification ─────────────────────────────────────────

/**
 * Extracts and verifies a Bearer token from the Authorization header.
 * Returns the server record on success, null on failure.
 * Constant-time comparison to prevent timing attacks.
 */
export async function verifyBearerToken(
  authHeader: string | null,
): Promise<typeof servers.$inferSelect | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const hash = hashApiKey(token);

  const results = await db.select().from(servers).where(eq(servers.apiKeyHash, hash));
  if (results.length !== 1) return null;

  // Constant-time comparison (double-check the full token)
  const expectedHash = results[0].apiKeyHash;
  const tokenHash = hashApiKey(token);
  try {
    if (!timingSafeEqual(Buffer.from(tokenHash), Buffer.from(expectedHash))) return null;
  } catch {
    return null;
  }

  // Update last_seen_at
  await db
    .update(servers)
    .set({ lastSeenAt: new Date() })
    .where(eq(servers.id, results[0].id));

  return results[0];
}

export function unauthorizedResponse(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

// ── Admin-only bearer verification ────────────────────────────────────

/**
 * Like verifyBearerToken, but also confirms the server's owner is admin.
 * Returns the server record only if the caller is the admin.
 */
export async function verifyAdminToken(
  authHeader: string | null,
): Promise<typeof servers.$inferSelect | null> {
  const server = await verifyBearerToken(authHeader);
  if (!server) return null;

  const members = await db
    .select()
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, server.id),
        eq(serverMembers.userId, server.userId),
        eq(serverMembers.role, "admin"),
      ),
    );

  return members.length === 1 ? server : null;
}
