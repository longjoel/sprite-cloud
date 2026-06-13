import { db } from "@/lib/db";
import { pairingCodes } from "@/lib/db/schema";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function generateCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  }
  return code;
}

export async function createPairingCode(): Promise<string> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await db.insert(pairingCodes).values({
    code,
    status: "pending",
    expiresAt,
  });

  return code;
}
