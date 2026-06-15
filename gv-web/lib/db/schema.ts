import { jsonb, pgTable, text, timestamp, unique, uuid, integer, bigint, index } from "drizzle-orm/pg-core";

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
// Commands are transient — created by browser users, delivered to gv-server,
// then marked delivered. Not the same as sessions (which track game lifecycle).

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
  // pending → delivered
  workerToken: text("worker_token"),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Game sessions (one per game start) ────────────────────────────────

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  serverId: uuid("server_id").references(() => servers.id),
  commandId: uuid("command_id").references(() => commands.id),
  gameId: text("game_id").notNull(),
  workerUrl: text("worker_url"),
  sdpAnswer: text("sdp_answer"),
  status: text("status").notNull().default("pending"),
  // pending → ready → active → ended
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
