import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { devices } from "@/lib/db/schema";
import { pollCommands } from "@/lib/commands";
import { eq } from "drizzle-orm";

export async function GET(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const device = await db.query.devices.findFirst({
    where: eq(devices.authToken, token),
  });
  if (!device) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Update last seen
  await db
    .update(devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(devices.id, device.id));

  const cmds = await pollCommands(device.id);

  return NextResponse.json({
    commands: cmds,
    pollMs: cmds.length > 0 ? 250 : 2000,
  });
}
