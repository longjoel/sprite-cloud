import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { inviteCodes, servers } from "@/lib/db/schema";
import {
  hashInviteCode,
  inviteUnavailableReason,
  InviteRedemptionError,
  redeemInviteAccount,
} from "@/lib/invites";
import { checkRateLimit, getClientIP } from "@/lib/rate-limit";

function validCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(code) || /^[a-f0-9]{16}$/.test(code);
}

function validCsrf(request: NextRequest): boolean {
  const cookie = request.cookies.get("sc_csrf_token")?.value;
  const header = request.headers.get("x-csrf-token");
  return Boolean(cookie && header && cookie === header);
}

async function lookupInvite(code: string) {
  const [invite] = await db
    .select({
      id: inviteCodes.id,
      serverId: inviteCodes.serverId,
      serverName: servers.name,
      kind: inviteCodes.kind,
      maxRedemptions: inviteCodes.maxRedemptions,
      redemptionCount: inviteCodes.redemptionCount,
      expiresAt: inviteCodes.expiresAt,
      revokedAt: inviteCodes.revokedAt,
    })
    .from(inviteCodes)
    .leftJoin(servers, eq(servers.id, inviteCodes.serverId))
    .where(eq(inviteCodes.codeHash, hashInviteCode(code)))
    .limit(1);
  return invite;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  if (!validCode(code)) return NextResponse.json({ error: "invite not found" }, { status: 404 });
  const invite = await lookupInvite(code);
  if (!invite) return NextResponse.json({ error: "invite not found" }, { status: 404 });
  const unavailable = inviteUnavailableReason(invite);
  if (unavailable) return NextResponse.json({ error: `invite ${unavailable}` }, { status: 410 });
  return NextResponse.json({
    invite: {
      serverName: invite.kind === "bootstrap" ? "Sprite Cloud first-run setup" : invite.serverName,
      remainingRedemptions: invite.maxRedemptions - invite.redemptionCount,
      expiresAt: invite.expiresAt,
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  if (!validCode(code)) return NextResponse.json({ error: "invite not found" }, { status: 404 });
  if (!validCsrf(request)) return NextResponse.json({ error: "invalid csrf token" }, { status: 403 });
  const rateLimit = checkRateLimit(`invite-redemption:${getClientIP(request)}`, 10, 15 * 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "too many enrollment attempts" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } },
    );
  }

  let body: { name?: string; email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase() ?? "";
  const name = body.name?.trim() ?? "";
  const password = body.password ?? "";
  if (!email.includes("@") || email.length < 5 || email.length > 320) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }
  if (!name || name.length > 80) {
    return NextResponse.json({ error: "display name is required (max 80 characters)" }, { status: 400 });
  }
  if (password.length < 8 || password.length > 128) {
    return NextResponse.json({ error: "password must be 8 to 128 characters" }, { status: 400 });
  }

  // Reject invalid capabilities before doing intentionally expensive password hashing.
  const preflight = await lookupInvite(code);
  if (!preflight) return NextResponse.json({ error: "invite not found" }, { status: 404 });
  const preflightUnavailable = inviteUnavailableReason(preflight);
  if (preflightUnavailable) {
    return NextResponse.json({ error: `invite ${preflightUnavailable}` }, { status: 410 });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const codeHash = hashInviteCode(code);

  try {
    const result = await redeemInviteAccount(db, { codeHash, name, email, passwordHash });
    console.log(JSON.stringify({
      service: "sc-web",
      msg: "enrollment invite redeemed",
      user_id: result.user.id,
      server_id: result.serverId,
    }));
    return NextResponse.json({ ok: true, user: result.user }, { status: 201 });
  } catch (error) {
    if (error instanceof InviteRedemptionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("invite redemption error:", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
