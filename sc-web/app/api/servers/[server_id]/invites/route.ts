import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { inviteCodes, inviteRedemptions, users } from "@/lib/db/schema";
import { generateInviteCode, requireServerAdmin } from "@/lib/invites";

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

async function authorize(serverId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!await requireServerAdmin(session.user.id, serverId)) {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { userId: session.user.id };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const { server_id } = await params;
  const access = await authorize(server_id);
  if ("error" in access) return access.error;

  const invites = await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.serverId, server_id))
    .orderBy(desc(inviteCodes.createdAt));

  const redemptions = await db
    .select({
      inviteCodeId: inviteRedemptions.inviteCodeId,
      redeemedAt: inviteRedemptions.redeemedAt,
      userId: users.id,
      email: users.email,
      name: users.name,
    })
    .from(inviteRedemptions)
    .innerJoin(inviteCodes, eq(inviteCodes.id, inviteRedemptions.inviteCodeId))
    .innerJoin(users, eq(users.id, inviteRedemptions.userId))
    .where(eq(inviteCodes.serverId, server_id));

  return NextResponse.json({
    invites: invites.map((invite) => ({
      id: invite.id,
      codePrefix: invite.codePrefix,
      maxRedemptions: invite.maxRedemptions,
      redemptionCount: invite.redemptionCount,
      expiresAt: invite.expiresAt,
      revokedAt: invite.revokedAt,
      createdAt: invite.createdAt,
      redemptions: redemptions.filter((row) => row.inviteCodeId === invite.id),
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ server_id: string }> },
) {
  const { server_id } = await params;
  const access = await authorize(server_id);
  if ("error" in access) return access.error;
  if (!validCsrf(request)) return NextResponse.json({ error: "invalid csrf token" }, { status: 403 });

  let body: { maxRedemptions?: number; expiresInHours?: number | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const maxRedemptions = body.maxRedemptions ?? 1;
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1 || maxRedemptions > 100) {
    return NextResponse.json({ error: "maxRedemptions must be an integer from 1 to 100" }, { status: 400 });
  }
  const hours = body.expiresInHours;
  if (hours != null && (!Number.isInteger(hours) || hours < 1 || hours > 8760)) {
    return NextResponse.json({ error: "expiresInHours must be an integer from 1 to 8760" }, { status: 400 });
  }

  const { code, codeHash } = generateInviteCode();
  const expiresAt = hours == null ? null : new Date(Date.now() + hours * 60 * 60 * 1000);
  const [invite] = await db.insert(inviteCodes).values({
    codeHash,
    codePrefix: code.slice(0, 8),
    kind: "server",
    serverId: server_id,
    createdBy: access.userId,
    maxRedemptions,
    expiresAt,
  }).returning({ id: inviteCodes.id, createdAt: inviteCodes.createdAt });

  return NextResponse.json({
    invite: {
      id: invite.id,
      code,
      url: `/invite/${code}`,
      maxRedemptions,
      expiresAt,
      createdAt: invite.createdAt,
    },
  }, { status: 201 });
}
