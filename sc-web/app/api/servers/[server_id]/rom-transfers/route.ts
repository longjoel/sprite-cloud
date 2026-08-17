import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { commands, serverMembers, servers, users } from "@/lib/db/schema";
import { CMD_ROM_TRANSFER } from "@/lib/constants";
import { applyRateLimit } from "@/lib/rate-limit";
import { and, eq } from "drizzle-orm";
import crypto from "crypto";

// ── Configuration ──────────────────────────────────────────────────────

const TRANSFER_RATE_LIMIT = 10; // requests per minute per IP
const CAPABILITY_TTL_MINUTES = 5;
const MAX_FILENAME_BYTES = 255;
const MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB (sc-server enforces tighter)
const VALID_PLATFORM_HINTS = new Set([
  "nes", "snes", "n64", "gb", "gba", "genesis", "sega32x",
  "segacd", "psx", "psp", "nds", "dreamcast", "arcade",
  "atari2600", "atari7800", "pcengine", "pcenginecd",
  "wonderswan", "wonderswancolor", "neogeo", "neogeocd",
  "pokemini", "virtualboy", "vb", "gamegear",
]);

// ── Validation helpers ─────────────────────────────────────────────────

interface RomTransferBody {
  basename: string;
  declared_size: number;
  platform_hint?: string;
}

function validateRomTransferBody(body: unknown): { ok: true; value: RomTransferBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be an object" };
  }

  const b = body as Record<string, unknown>;

  // basename — required, non-empty, sane length
  if (typeof b.basename !== "string" || b.basename.trim().length === 0) {
    return { ok: false, error: "basename is required and must be a non-empty string" };
  }
  const basename = b.basename.trim();
  if (Buffer.byteLength(basename, "utf8") > MAX_FILENAME_BYTES) {
    return { ok: false, error: `basename exceeds ${MAX_FILENAME_BYTES} bytes` };
  }
  // No path traversal or null bytes
  if (basename.includes("\x00") || basename.includes("/") || basename.includes("\\")) {
    return { ok: false, error: "basename must not contain path separators or null bytes" };
  }

  // declared_size — required, positive safe integer
  if (
    typeof b.declared_size !== "number" ||
    !Number.isSafeInteger(b.declared_size) ||
    b.declared_size < 1
  ) {
    return { ok: false, error: "declared_size must be a positive integer" };
  }
  if (b.declared_size > MAX_SIZE_BYTES) {
    return { ok: false, error: `declared_size exceeds maximum of ${MAX_SIZE_BYTES} bytes` };
  }

  // platform_hint — optional, must be valid
  if (b.platform_hint !== undefined) {
    if (typeof b.platform_hint !== "string") {
      return { ok: false, error: "platform_hint must be a string" };
    }
    if (!VALID_PLATFORM_HINTS.has(b.platform_hint)) {
      return { ok: false, error: `unknown platform_hint: ${b.platform_hint}` };
    }
  }

  const extra = Object.keys(b).filter((k) => !["basename", "declared_size", "platform_hint"].includes(k));
  if (extra.length > 0) {
    return { ok: false, error: `unexpected fields: ${extra.join(", ")}` };
  }

  return {
    ok: true,
    value: {
      basename,
      declared_size: b.declared_size,
      platform_hint: typeof b.platform_hint === "string" ? b.platform_hint : undefined,
    },
  };
}

// ── CSRF ───────────────────────────────────────────────────────────────

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function validateCsrf(request: NextRequest): boolean {
  const headerToken = request.headers.get("x-csrf-token");
  const cookieToken = cookieValue(request.headers.get("cookie"), "sc_csrf_token");
  return !!headerToken && !!cookieToken && headerToken === cookieToken;
}

// ── Handler ────────────────────────────────────────────────────────────

/**
 * POST /api/servers/[server_id]/rom-transfers
 *
 * Authorizes a ROM upload or download transfer for an administrator of
 * the target server.  Returns a one-time capability secret (plaintext)
 * that the browser uses in the WebRTC data channel.  Only the SHA-256
 * hash of the secret is stored in the command payload — the raw secret
 * is never persisted or logged.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const { server_id } = await params;

  // ── Rate limiting ──────────────────────────────────────────────────
  const rateLimited = applyRateLimit(request, TRANSFER_RATE_LIMIT);
  if (rateLimited) return rateLimited;

  // ── Authentication ─────────────────────────────────────────────────
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  if (!validateCsrf(request)) {
    return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });
  }

  // ── Validate body ──────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = validateRomTransferBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { basename, declared_size, platform_hint } = parsed.value;

  // ── Server membership + admin check ────────────────────────────────
  const [membership] = await db
    .select({ role: serverMembers.role, serverName: servers.name })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(
      and(
        eq(serverMembers.serverId, server_id),
        eq(serverMembers.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!membership) {
    return NextResponse.json({ error: "server not found or not authorized" }, { status: 403 });
  }
  if (membership.role !== "admin") {
    return NextResponse.json({ error: "administrator role required for ROM transfers" }, { status: 403 });
  }

  // ── Generate one-time capability ───────────────────────────────────
  // The raw secret is returned once.  Only SHA-256(secret) goes into the
  // command payload so sc-server can verify without ever seeing the raw value
  // in its polling response.
  const capabilitySecret = crypto.randomBytes(32).toString("hex"); // 64 hex chars
  const capabilityHash = crypto.createHash("sha256").update(capabilitySecret).digest("hex");

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CAPABILITY_TTL_MINUTES * 60_000);

  // ── Queue transfer command for sc-server ───────────────────────────
  const transferId = crypto.randomUUID();

  const accountUserId = session.user.id;
  const commandPayload = {
    transfer_id: transferId,
    operation: "upload" as const,
    authorized_user_id: session.user.id,
    capability_hash: capabilityHash,
    constraints: {
      basename,
      declared_size,
      platform_hint: platform_hint ?? null,
      max_size: MAX_SIZE_BYTES,
    },
    expires_at: expiresAt.toISOString(),
  };

  const [cmd] = await db.transaction(async (tx) => {
    const [account] = await tx.select({ id: users.id }).from(users).where(eq(users.id, accountUserId)).for("update");
    if (!account) throw new Error("account no longer exists");
    return tx.insert(commands).values({
      serverId: server_id,
      type: CMD_ROM_TRANSFER,
      payload: commandPayload,
      status: "preparing" as const,
    }).returning({ id: commands.id });
  });

  // ── Return capability to browser (once) ────────────────────────────
  return NextResponse.json({
    transfer_id: transferId,
    expires_at: expiresAt.toISOString(),
    operation: "upload",
    capability_secret: capabilitySecret,
    command_id: cmd.id,
    // Signaling bootstrap: the browser must establish a WebRTC data channel
    // to sc-server; these are the ICE/config hints it will need.
    signaling: {
      server_id,
      transfer_id: transferId,
    },
  });
}
