/**
 * User/server/membership fabrication for L2 E2E (#662 slice 3).
 *
 * Tests need known users with known credentials in the gateway DB, and the
 * whole point of accounts (#745) is exercising *different users against
 * each other*. Because auth is NextAuth-credentials + bcrypt (no OAuth
 * provider), we insert users directly — same hash cost as prod — and sign
 * in through the REAL login form, keeping the auth journey under test.
 *
 * Every call fabricates fresh, uuid-suffixed identities against the
 * disposable test Postgres — no shared state, no cross-run contamination.
 */
import postgres from "postgres";
import bcrypt from "bcryptjs";

export const TEST_PASSWORD = "fixture-password-123";

/** Random 8-char alphanumeric pairing code (uppercase, no I/O/1). */
export function randomPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return raw.slice(0, 4) + "-" + raw.slice(4);
}

export interface FabricatedUser {
  id: string;
  email: string;
  password: string;
}

export interface FabricatedServer {
  id: string;
  apiKey: string;
}

export interface FabricatedPairingCode {
  code: string; // formatted MKQZ-APLE
  userId: string;
}

/**
 * Open a connection to the gateway test DB. URL from GATEWAY_DATABASE_URL.
 */
export function openDb(): postgres.Sql {
  const url = process.env.GATEWAY_DATABASE_URL;
  if (!url) throw new Error("GATEWAY_DATABASE_URL not set");
  return postgres(url, { max: 4 });
}

/** Insert a user with a known bcrypt password (cost 10, same as prod). */
export async function fabricateUser(
  sql: postgres.Sql,
  email: string,
): Promise<FabricatedUser> {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const [row] = await sql`
    INSERT INTO users (email, password_hash)
    VALUES (${email}, ${passwordHash})
    RETURNING id, email
  `;
  return { id: row.id, email: row.email, password: TEST_PASSWORD };
}

/** Insert a server owned by `ownerId`; returns its id + plaintext API key. */
export async function fabricateServer(
  sql: postgres.Sql,
  ownerId: string,
  name: string,
): Promise<FabricatedServer> {
  // generateApiKey() in sc-web is 32 hex chars; hashApiKey is sha256.
  const apiKey = randomHex(32);
  const apiKeyHash = sha256Hex(apiKey);
  const [row] = await sql`
    INSERT INTO servers (user_id, name, api_key_hash)
    VALUES (${ownerId}, ${name}, ${apiKeyHash})
    RETURNING id
  `;
  return { id: row.id, apiKey };
}

/** Grant `userId` membership on `serverId` with a role (admin|member). */
export async function fabricateMembership(
  sql: postgres.Sql,
  serverId: string,
  userId: string,
  role: "admin" | "member" = "member",
): Promise<void> {
  await sql`
    INSERT INTO server_members (server_id, user_id, role)
    VALUES (${serverId}, ${userId}, ${role})
  `;
}

/** Mint a pending pairing code owned by `userId`. */
export async function fabricatePairingCode(
  sql: postgres.Sql,
  userId: string,
): Promise<FabricatedPairingCode> {
  const code = randomPairingCode();
  await sql`
    INSERT INTO pairing_codes (code, user_id, status, expires_at)
    VALUES (${code}, ${userId}, 'pending', now() + interval '1 hour')
  `;
  return { code, userId };
}

/** Insert a game row on a server (mirrors what sync-games would produce). */
export async function fabricateGame(
  sql: postgres.Sql,
  serverId: string,
  gameId: string,
  name: string,
  platform: string,
): Promise<void> {
  await sql`
    INSERT INTO server_games (server_id, game_id, name, platform)
    VALUES (${serverId}, ${gameId}, ${name}, ${platform})
    ON CONFLICT (server_id, game_id) DO NOTHING
  `;
}

// ── helpers ──────────────────────────────────────────────────────────

function randomHex(len: number): string {
  const bytes = new Uint8Array(len / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

import { createHash } from "node:crypto";
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Teardown helper: truncate the tables we touch (fresh per run anyway). */
export async function cleanupAll(sql: postgres.Sql): Promise<void> {
  await sql`
    TRUNCATE short_codes, sessions, server_members, server_games, pairing_codes, servers, users CASCADE
  `;
}
