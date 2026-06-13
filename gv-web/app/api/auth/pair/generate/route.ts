import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { pairingCodes } from "@/lib/db/schema";
import { generatePairingCode, pairingCodeExpiresAt } from "@/lib/server-auth";

// POST /api/auth/pair/generate — authenticated user creates a pairing code
export async function POST() {
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
