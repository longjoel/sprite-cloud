import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { servers, sessions } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────

interface ComponentStatus {
  status: "ok" | "degraded" | "error";
  detail?: string;
}

interface HealthResponse {
  status: "ok" | "degraded" | "error";
  components: {
    db: ComponentStatus;
    api_routes: ComponentStatus;
    gv_server: ComponentStatus;
    schema: ComponentStatus;
  };
  timestamp: string;
}

// ── Checks ────────────────────────────────────────────────────────────

async function checkDb(): Promise<ComponentStatus> {
  try {
    await db.execute(sql`SELECT 1`);
    return { status: "ok" };
  } catch (e) {
    return { status: "error", detail: String(e) };
  }
}

async function checkApiRoutes(): Promise<ComponentStatus> {
  try {
    // Verify the sessions table is queryable — proves schema was applied.
    await db.select().from(sessions).limit(1);
    return { status: "ok" };
  } catch (e) {
    return {
      status: "error",
      detail: `sessions table not queryable — schema may not be applied: ${String(e)}`,
    };
  }
}

async function checkGvServer(): Promise<ComponentStatus> {
  try {
    // Check if any server has polled within the last 60 seconds.
    const recent = await db
      .select({ id: servers.id, lastSeenAt: servers.lastSeenAt })
      .from(servers)
      .orderBy(desc(servers.lastSeenAt))
      .limit(1);

    if (recent.length === 0) {
      return { status: "degraded", detail: "No servers paired" };
    }

    const lastSeen = recent[0].lastSeenAt;
    if (!lastSeen) {
      return { status: "degraded", detail: "Server has never polled" };
    }

    const ageSecs = (Date.now() - lastSeen.getTime()) / 1000;
    if (ageSecs > 60) {
      return {
        status: "degraded",
        detail: `Last poll ${Math.round(ageSecs)}s ago`,
      };
    }

    return { status: "ok" };
  } catch (e) {
    return { status: "error", detail: String(e) };
  }
}

async function checkSchema(): Promise<ComponentStatus> {
  try {
    // Verify sessions table has critical columns by querying them.
    // If a column is missing (migration not applied), the query throws.
    await db
      .select({
        id: sessions.id,
        roomToken: sessions.roomToken,
        maxSeats: sessions.maxSeats,
        sdpAnswer: sessions.sdpAnswer,
      })
      .from(sessions)
      .limit(1);

    return { status: "ok" };
  } catch (e) {
    const msg = String(e);
    if (msg.includes("does not exist") || msg.includes("column")) {
      return {
        status: "error",
        detail: "Missing columns — run drizzle-kit push",
      };
    }
    return { status: "error", detail: msg };
  }
}

// ── Aggregation ───────────────────────────────────────────────────────

function overallStatus(
  components: HealthResponse["components"]
): "ok" | "degraded" | "error" {
  const statuses = Object.values(components).map((c) => c.status);
  if (statuses.includes("error")) return "error";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

// ── Route ─────────────────────────────────────────────────────────────

// GET /api/health — deep stack health check (no auth required)
export async function GET() {
  const components = {
    db: await checkDb(),
    api_routes: await checkApiRoutes(),
    gv_server: await checkGvServer(),
    schema: await checkSchema(),
  };

  const status = overallStatus(components);

  const body: HealthResponse = {
    status,
    components,
    timestamp: new Date().toISOString(),
  };

  const httpStatus =
    status === "error" ? 503 : status === "degraded" ? 200 : 200;

  return NextResponse.json(body, { status: httpStatus });
}
