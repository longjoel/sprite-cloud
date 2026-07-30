import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { commands } from "@/lib/db/schema";
import { CMD_ROM_TRANSFER, STATUS_PENDING } from "@/lib/constants";
import { applyRateLimit } from "@/lib/rate-limit";
import { eq, and, sql } from "drizzle-orm";
import crypto from "crypto";

// ── Configuration ──────────────────────────────────────────────────────

const OFFER_RATE_LIMIT = 10; // requests per minute per IP

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
 * POST /api/servers/[server_id]/rom-transfers/[transfer_id]/offer
 *
 * Attaches the browser's WebRTC SDP offer to a prepared ROM transfer
 * command and activates it for sc-server polling.  The caller must
 * present the one-time capability secret that matches the SHA-256 hash
 * stored in the command payload.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ server_id: string; transfer_id: string }> },
) {
  const { server_id, transfer_id } = await params;

  // ── Rate limiting ──────────────────────────────────────────────────
  const rateLimited = applyRateLimit(request, OFFER_RATE_LIMIT);
  if (rateLimited) return rateLimited;

  if (!validateCsrf(request)) {
    return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });
  }

  // ── Parse body ─────────────────────────────────────────────────────
  let body: { sdp?: unknown; capability_secret?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (typeof body.sdp !== "string" || body.sdp.length === 0) {
    return NextResponse.json({ error: "sdp is required and must be a non-empty string" }, { status: 400 });
  }
  if (typeof body.capability_secret !== "string" || body.capability_secret.length === 0) {
    return NextResponse.json({ error: "capability_secret is required" }, { status: 400 });
  }

  const sdp = body.sdp;
  const capabilitySecret = body.capability_secret;

  // ── Find the prepared command ──────────────────────────────────────
  // The transfer_id is embedded in the JSON payload.
  // Use Postgres JSON operator to find the command.
  const [cmd] = await db
    .select({
      id: commands.id,
      type: commands.type,
      payload: commands.payload,
      status: commands.status,
      serverId: commands.serverId,
    })
    .from(commands)
    .where(
      and(
        eq(commands.serverId, server_id),
        eq(commands.type, CMD_ROM_TRANSFER),
        eq(commands.status, "preparing"),
        sql`${commands.payload}->>'transfer_id' = ${transfer_id}`,
      ),
    )
    .limit(1);

  if (!cmd) {
    return NextResponse.json(
      { error: "transfer not found, already activated, or expired" },
      { status: 404 },
    );
  }

  // ── Verify capability ──────────────────────────────────────────────
  const payload = cmd.payload as Record<string, unknown>;
  const storedHash = payload.capability_hash;
  if (typeof storedHash !== "string") {
    return NextResponse.json({ error: "invalid command state" }, { status: 500 });
  }

  const computedHash = crypto
    .createHash("sha256")
    .update(capabilitySecret)
    .digest("hex");

  // Constant-time comparison (timing-safe)
  if (storedHash.length !== computedHash.length) {
    return NextResponse.json({ error: "invalid capability" }, { status: 403 });
  }
  let diff = 0;
  for (let i = 0; i < storedHash.length; i++) {
    diff |= storedHash.charCodeAt(i) ^ computedHash.charCodeAt(i);
  }
  if (diff !== 0) {
    return NextResponse.json({ error: "invalid capability" }, { status: 403 });
  }

  // ── Check expiry ───────────────────────────────────────────────────
  const expiresAt = payload.expires_at;
  if (typeof expiresAt === "string" && new Date(expiresAt) < new Date()) {
    return NextResponse.json({ error: "transfer capability expired" }, { status: 410 });
  }

  // ── Attach SDP and activate ────────────────────────────────────────
  const enrichedPayload = {
    ...payload,
    sdp,
  };

  const [activated] = await db
    .update(commands)
    .set({
      payload: enrichedPayload,
      status: STATUS_PENDING,
    })
    .where(
      and(
        eq(commands.id, cmd.id),
        eq(commands.serverId, server_id),
        eq(commands.type, CMD_ROM_TRANSFER),
        eq(commands.status, "preparing"),
        sql`${commands.payload}->>'transfer_id' = ${transfer_id}`,
      ),
    )
    .returning({ id: commands.id });

  if (!activated) {
    return NextResponse.json(
      { error: "transfer already activated" },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    command_id: cmd.id,
    transfer_id,
  });
}
