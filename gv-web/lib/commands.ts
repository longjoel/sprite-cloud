import { db } from "@/lib/db";
import { commands } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function queueCommand(
  deviceId: string,
  type: string,
  payload: unknown
) {
  await db.insert(commands).values({
    deviceId,
    type,
    payload: JSON.stringify(payload),
    status: "pending",
  });
}

export async function pollCommands(
  deviceId: string
): Promise<Array<{ id: string; type: string; payload: unknown }>> {
  const pending = await db.query.commands.findMany({
    where: and(
      eq(commands.deviceId, deviceId),
      eq(commands.status, "pending")
    ),
    limit: 10,
  });

  if (pending.length > 0) {
    await db
      .update(commands)
      .set({ status: "delivered" })
      .where(
        and(
          eq(commands.deviceId, deviceId),
          eq(commands.status, "pending")
        )
      );
  }

  return pending.map((c) => ({
    id: c.id,
    type: c.type,
    payload: JSON.parse(c.payload),
  }));
}
