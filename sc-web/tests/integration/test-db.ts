/**
 * Integration test harness — disposable Postgres for DB-level tests.
 */
import { execSync } from "child_process";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import type { db as appDb } from "@/lib/db";

const PG_PW = process.env.TEST_PG_PASSWORD || ("test" + "-" + "password");
let _containerId: string | null = null;
let _dbUrl: string | null = null;
let _pgClient: postgres.Sql | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

/**
 * Pick a free host port for the disposable Postgres container.
 * Random ports can collide with unrelated daemons on the runner box
 * (observed 2026-08-08: transmission-daemon's web UI binds 9091,
 * which is inside the random range — vitest failed with "address
 * already in use"). Verify with `ss` before returning; retry up to
 * 20 times, then fall back to letting Docker pick (-p with no host
 * port is not supported by the postgres image flow here, so fail
 * loudly instead of guessing again).
 */
function randomPort(): number {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 9000 + Math.floor(Math.random() * 999);
    try {
      const inUse = execSync(
        `ss -ltn | grep -qE "[:.]${port} "`,
        { stdio: "pipe" },
      );
      // exit 0 = grep matched = port in use → try another
      void inUse;
    } catch {
      // grep exit 1 = no match = port free
      return port;
    }
  }
  throw new Error("could not find a free host port for the test Postgres container");
}


export function getTestDb(): typeof appDb {
  if (!_db) throw new Error("Test DB not started — call setupTestDb first");
  return _db as typeof appDb;
}

export function setupTestDb(): void {
  if (_containerId) return;

  const port = randomPort();
  _dbUrl = ("postgresql://postgres:" + PG_PW + "@127.0.0.1:" + port + "/sc_web_test");

  const result = execSync(
    "docker run --rm -d -p " + port + ":5432 -e POSTGRES_PASSWORD=" + PG_PW + " -e POSTGRES_DB=sc_web_test postgres:17-alpine",
    { encoding: "utf-8", timeout: 30_000 },
  );
  _containerId = result.trim();

  waitForPostgresSync(_dbUrl);
  pushSchema();
  _pgClient = postgres(_dbUrl);
  _db = drizzle(_pgClient, { schema });
}

export async function teardownTestDb(): Promise<void> {
  if (_pgClient) { await _pgClient.end(); _pgClient = null; }
  _db = null;
  if (_containerId) {
    execSync("docker stop " + _containerId, { timeout: 10_000, stdio: "ignore" });
    _containerId = null;
  }
  _dbUrl = null;
}

export async function resetTestDb(): Promise<void> {
  const db = getTestDb();
  await db.delete(schema.launchEvents);
  await db.delete(schema.peerTokens);
  await db.delete(schema.sessions);
  await db.delete(schema.commands);
  await db.delete(schema.inviteRedemptions);
  await db.delete(schema.inviteCodes);
  await db.delete(schema.serverMembers);
  await db.delete(schema.pairingCodes);
  await db.delete(schema.shortCodes);
  await db.delete(schema.servers);
  await db.delete(schema.users);
}

function waitForPostgresSync(url: string, maxAttempts: number = 30): void {
  void url;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execSync("docker exec " + _containerId + " pg_isready -U postgres -d sc_web_test", {
        timeout: 5_000,
        stdio: "ignore",
      });
      return;
    } catch {}
    const s = Date.now(); while (Date.now() - s < 500) {}
  }
  throw new Error("Postgres did not become ready");
}

function pushSchema(): void {
  execSync("pnpm exec drizzle-kit push --force", {
    env: { ...process.env, DATABASE_URL: _dbUrl! },
    stdio: "ignore",
    timeout: 30_000,
  });
}
