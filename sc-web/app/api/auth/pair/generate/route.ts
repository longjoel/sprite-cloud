import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { pairingCodes } from "@/lib/db/schema";
import { generatePairingCode, pairingCodeExpiresAt } from "@/lib/server-auth";
import { applyRateLimit } from "@/lib/rate-limit";

const PAIR_RATE_LIMIT = 10; // requests per minute per IP

// POST /api/auth/pair/generate — authenticated user creates a pairing code
export async function POST(request: Request) {
  // Rate limiting — 10 req/min per IP
  const rateLimited = applyRateLimit(request, PAIR_RATE_LIMIT);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  const code = generatePairingCode();

  await db.insert(pairingCodes).values({
    code,
    userId: session.user.id,
    status: "pending",
    expiresAt: pairingCodeExpiresAt(),
  });

  return NextResponse.json({ code });
}
