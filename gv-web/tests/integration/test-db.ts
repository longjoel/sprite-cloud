/**
 * Integration test harness — disposable Postgres for DB-level tests.
 */
import { execSync } from "child_process";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";

const PG_PW = process.env.TEST_PG_PASSWORD || ("test" + "-" + "password");
let _containerId: string | null = null;
let _dbUrl: string | null = null;
let _pgClient: postgres.Sql | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

function randomPort(): number {
  return 9000 + Math.floor(Math.random() * 999);
}

export function getTestDbUrl(): string {
  if (!_dbUrl) throw new Error("Test DB not started — call setupTestDb first");
  return _dbUrl;
}

export function getTestDb() {
  if (!_db) throw new Error("Test DB not started — call setupTestDb first");
  return _db;
}

export function setupTestDb(): void {
  if (_containerId) return;

  const port = randomPort();
  _dbUrl = ("postgresql://postgres:" + PG_PW + "@127.0.0.1:" + port + "/gv_web_test");

  const result = execSync(
    "docker run --rm -d -p " + port + ":5432 -e POSTGRES_PASSWORD=" + PG_PW + " -e POSTGRES_DB=gv_web_test postgres:17-alpine",
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
  await db.delete(schema.gameFiles);
  await db.delete(schema.games);
  await db.delete(schema.serverRomRoots);
  await db.delete(schema.serverMembers);
  await db.delete(schema.pairingCodes);
  await db.delete(schema.servers);
  await db.delete(schema.users);
}

function waitForPostgresSync(url: string, maxAttempts: number = 30): void {
  void url;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execSync("docker exec " + _containerId + " pg_isready -U postgres -d gv_web_test", {
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
