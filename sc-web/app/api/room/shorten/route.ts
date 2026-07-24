import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, shortCodes } from "@/lib/db/schema";
import { verifyBearerToken } from "@/lib/server-auth";
import { and, eq } from "drizzle-orm";
import crypto from "crypto";

function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

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

export async function POST(request: NextRequest) {
  let body: { game_id: string; host_token: string; server_id: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const gameId = body.game_id;
  const hostToken = body.host_token;
  const serverId = body.server_id;

  if (!/^local_[0-9a-f]{32}$/.test(gameId ?? "")) {
    return NextResponse.json({ error: "opaque game_id required" }, { status: 400 });
  }
  if (!hostToken || typeof hostToken !== "string" || hostToken.length > 128) {
    return NextResponse.json({ error: "host_token required" }, { status: 400 });
  }
  if (!serverId || typeof serverId !== "string" || serverId.length > 128) {
    return NextResponse.json({ error: "server_id required" }, { status: 400 });
  }

  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (server) {
    if (server.id !== serverId) {
      return NextResponse.json({ error: "server token does not match server_id" }, { status: 403 });
    }
  } else {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    if (!validateCsrf(request)) {
      return NextResponse.json({ error: "csrf token invalid" }, { status: 403 });
    }
    const [membership] = await db
      .select({ role: serverMembers.role })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, session.user.id)))
      .limit(1);
    if (!membership) {
      return NextResponse.json({ error: "server not found or not authorized" }, { status: 403 });
    }
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      await db.insert(shortCodes).values({ code, gameId, hostToken, serverId });
      return NextResponse.json({ code }, { status: 201 });
    } catch (err: unknown) {
      const dbError = err as { code?: string; message?: string };
      if (dbError.code === "23505" || dbError.message?.includes("duplicate key")) continue;
      throw err;
    }
  }

  return NextResponse.json({ error: "could not generate unique code" }, { status: 500 });
}
