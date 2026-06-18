import { jsonb, pgTable, text, timestamp, unique, uuid, integer, bigint, index, boolean } from "drizzle-orm/pg-core";

// ── Users (created via OAuth) ────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Servers (gv-server instances, paired via code) ───────────────────

export const servers = pgTable("servers", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  name: text("name").notNull().default(""),
  apiKeyHash: text("api_key_hash").notNull().unique(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Server members (which users can play on which servers) ───────────

export const serverMembers = pgTable(
  "server_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .references(() => servers.id)
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    role: text("role").notNull().default("member"),
    // admin | member
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    unq: unique("server_members_server_user").on(
      table.serverId,
      table.userId,
    ),
  }),
);

// ── Pairing codes (one-time, short-lived, user-facing) ───────────────

export const pairingCodes = pgTable("pairing_codes", {
  code: text("code").primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  status: text("status").notNull().default("pending"),
  // pending → claimed → expired
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Command queue (gv-server polls for pending work) ──────────────────
//
// Commands are transient — created by browser users, leased by gv-server,
// then marked completed/failed. Not the same as sessions (which track game lifecycle).

export const commands = pgTable("commands", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id")
    .references(() => servers.id)
    .notNull(),
  type: text("type").notNull(),
  // "start_game" | "stop_game" | "sdp_offer"
  payload: jsonb("payload").notNull().default({}),
  // shape varies by command type
  status: text("status").notNull().default("pending"),
  // pending → leased → completed | failed
  workerToken: text("worker_token"),
  leaseToken: text("lease_token"),
  leasedAt: timestamp("leased_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  lastError: text("last_error"),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Game sessions (one per game start) ────────────────────────────────

// ── Session state machine ───────────────────────────────────────────────
//
//  spawning → ready → connected → playing
//       ↓        ↓         ↓          ↓
//    timed_out  timed_out  timed_out  ended
//
//  Transitions:
//    start_game cmd  →  session created in "spawning"
//    server notify   →  "spawning" → "ready" (worker URL reported)
//    sdp_answer       →  "ready" → "connected" (SDP handshake complete)
//    dc open (client) →  "connected" → "playing" (DataChannel operational)
//    stop_game cmd   →  "playing" → "ended"
//    timeout (>60s)  →  "spawning" | "ready" | "connected" → "timed_out"
//    worker dead     →  "playing" | "connected" → "ended" (server notifies)

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  serverId: uuid("server_id").references(() => servers.id),
  commandId: uuid("command_id").references(() => commands.id),
  gameId: text("game_id").notNull(),
  hostToken: text("host_token"),
  workerUrl: text("worker_url"),
  sdpAnswer: text("sdp_answer"),
  roomToken: text("room_token").unique(),
  maxSeats: integer("max_seats").notNull().default(1),
  status: text("status").notNull().default("spawning"),
  // spawning → ready → connected → playing → ended | timed_out
  stateEnteredAt: timestamp("state_entered_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

// ── Server ROM roots (directories gv-server scans for game files) ─────
//
// Reported by gv-server during pairing. gv-web uses these to discover
// ROMs and resolve full paths for start_game commands.

export const serverRomRoots = pgTable(
  "server_rom_roots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .references(() => servers.id)
      .notNull(),
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    unq: unique("server_rom_roots_server_path").on(
      table.serverId,
      table.path,
    ),
  }),
);

// ── Games (library entries) ─────────────────────────────────────────

export const games = pgTable("games", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  platform: text("platform").notNull(),
  maxPlayers: integer("max_players").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Game files (ROM paths per server) ────────────────────────────────

export const gameFiles = pgTable(
  "game_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    gameId: uuid("game_id")
      .references(() => games.id)
      .notNull(),
    serverId: uuid("server_id")
      .references(() => servers.id)
      .notNull(),
    romPath: text("rom_path").notNull(),
    fileName: text("file_name").notNull(),
    fileSize: bigint("file_size", { mode: "number" }),
    fileHash: text("file_hash"),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    unq: unique("game_files_server_path").on(table.serverId, table.romPath),
    idxGame: index("idx_game_files_game").on(table.gameId),
    idxServer: index("idx_game_files_server").on(table.serverId),
  }),
);
