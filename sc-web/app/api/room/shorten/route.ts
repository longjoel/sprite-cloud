import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shortCodes } from "@/lib/db/schema";
import crypto from "crypto";

// ── POST /api/room/shorten — generate a short code for player reconnection
//
// Body: { game_id: string, host_token: string, server_id: string }
// Returns: { code: string } (6-char alphanumeric slug)

function randomCode(): string {
  // 6 chars from alphanumeric alphabet = 36^6 ≈ 2.2B combinations
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/l confusion
  const bytes = crypto.randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
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

  if (!gameId || typeof gameId !== "string" || gameId.length > 128) {
    return NextResponse.json({ error: "game_id required" }, { status: 400 });
  }
  if (!hostToken || typeof hostToken !== "string" || hostToken.length > 128) {
    return NextResponse.json({ error: "host_token required" }, { status: 400 });
  }
  if (!serverId || typeof serverId !== "string" || serverId.length > 128) {
    return NextResponse.json({ error: "server_id required" }, { status: 400 });
  }

  // Try up to 5 times in case of collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      await db.insert(shortCodes).values({
        code,
        gameId,
        hostToken,
        serverId,
      });
      return NextResponse.json({ code }, { status: 201 });
    } catch (err: any) {
      // Unique violation — collision, try another code
      if (err?.code === "23505" || err?.message?.includes("duplicate key")) {
        continue;
      }
      throw err;
    }
  }

  return NextResponse.json({ error: "could not generate unique code" }, { status: 500 });
}
