/**
 * Standalone cleanup script for gv-web database maintenance.
 *
 * Run inside the gv-web container:
 *   pnpm run cleanup:once
 *
 * Or during development:
 *   DATABASE_URL=postgresql://... pnpm run cleanup:once
 *
 * Exits 0 on success, 1 on error.
 */
import { db } from "../lib/db";
import { cleanupOnce } from "../lib/db/cleanup";

async function main() {
  console.log("[cleanup] starting...");
  await cleanupOnce();
  console.log("[cleanup] done");
  await (db as any).$client?.end?.();
  process.exit(0);
}

main().catch((err) => {
  console.error("[cleanup] error:", err);
  process.exit(1);
});
