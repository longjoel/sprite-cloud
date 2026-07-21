import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import SetupClient from "./SetupClient";
import fs from "fs";

export const dynamic = "force-dynamic";

const SETUP_CODE_PATH = "/tmp/sc-setup-code";

// ── Server component: gate → redirect or render client ────────────────

export default async function SetupPage() {
  // If users exist, /setup shouldn't be accessible
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users);

  if (Number(row?.count ?? 0) > 0) {
    redirect("/signin");
  }

  // Read the current setup code (or null if none generated yet)
  let setupCode: string | null = null;
  try {
    setupCode = fs.readFileSync(SETUP_CODE_PATH, "utf-8").trim();
  } catch {
    // No setup code file — instrumentation hasn't run yet
  }

  return <SetupClient initialCode={setupCode} />;
}
