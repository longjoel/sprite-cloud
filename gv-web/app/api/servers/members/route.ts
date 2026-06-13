import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverMembers, users } from "@/lib/db/schema";
import { verifyAdminToken, verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";
import { and, eq } from "drizzle-orm";

// GET /api/servers/members — list all members of this server
export async function GET(request: Request) {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse();

  const members = await db
    .select({
      userId: serverMembers.userId,
      role: serverMembers.role,
      name: users.name,
      email: users.email,
    })
    .from(serverMembers)
    .leftJoin(users, eq(serverMembers.userId, users.id))
    .where(eq(serverMembers.serverId, server.id));

  return NextResponse.json({ members });
}

// POST /api/servers/members — add a member (admin only)
export async function POST(request: NextRequest) {
  const server = await verifyAdminToken(request.headers.get("authorization"));
  if (!server) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }

  let body: { user_id: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body.user_id) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  // Prevent adding the admin themselves (already a member)
  if (body.user_id === server.userId) {
    return NextResponse.json(
      { error: "admin is already a member" },
      { status: 409 },
    );
  }

  // Check user exists
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, body.user_id));
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  // Insert (unique constraint prevents duplicates)
  try {
    await db.insert(serverMembers).values({
      serverId: server.id,
      userId: body.user_id,
      role: "member",
    });
  } catch {
    return NextResponse.json(
      { error: "already a member" },
      { status: 409 },
    );
  }

  return NextResponse.json({ status: "added" }, { status: 201 });
}

// DELETE /api/servers/members — remove a member (admin only)
export async function DELETE(request: NextRequest) {
  const server = await verifyAdminToken(request.headers.get("authorization"));
  if (!server) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }

  const userId = request.nextUrl.searchParams.get("user_id");
  if (!userId) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  // Can't remove the admin
  if (userId === server.userId) {
    return NextResponse.json(
      { error: "cannot remove admin" },
      { status: 403 },
    );
  }

  await db
    .delete(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, server.id),
        eq(serverMembers.userId, userId),
      ),
    );

  return NextResponse.json({ status: "removed" });
}
