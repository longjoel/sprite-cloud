import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { pairingCodes, devices } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";

export async function POST(req: Request) {
  const { code } = await req.json();
  if (!code || code.length !== 8) {
    return NextResponse.json({ status: "waiting" });
  }

  const normalized = code.toUpperCase();

  const pc = await db.query.pairingCodes.findFirst({
    where: and(
      eq(pairingCodes.code, normalized),
      eq(pairingCodes.status, "claimed")
    ),
  });

  if (!pc || !pc.userId) {
    return NextResponse.json({ status: "waiting" });
  }

  // Create device and return token
  const token = crypto.randomBytes(32).toString("hex");
  const [device] = await db
    .insert(devices)
    .values({
      userId: pc.userId,
      name: "",
      authToken: token,
    })
    .returning();

  // Mark code expired
  await db
    .update(pairingCodes)
    .set({ deviceId: device.id, status: "expired" })
    .where(eq(pairingCodes.code, normalized));

  return NextResponse.json({
    status: "paired",
    deviceId: device.id,
    authToken: token,
  });
}
