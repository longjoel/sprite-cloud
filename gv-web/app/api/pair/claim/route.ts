import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { pairingCodes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { code } = await req.json();
  if (!code || code.length !== 8) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const normalized = code.toUpperCase();
  const result = await db
    .update(pairingCodes)
    .set({ userId: session.user.id, status: "claimed" })
    .where(
      and(
        eq(pairingCodes.code, normalized),
        eq(pairingCodes.status, "pending")
      )
    )
    .returning();

  if (result.length === 0) {
    return NextResponse.json(
      { error: "Code expired or already claimed" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}
