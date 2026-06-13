import { db } from "@/lib/db";
import { commands } from "@/lib/db/schema";

async function main() {
  try {
    const result = await db.select().from(commands).limit(1);
    console.log("OK:", result);
  } catch (e: any) {
    console.error("ERR:", e.message, e.stack);
  }
  process.exit(0);
}

main();
