import { jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Game sessions (one per game start) ────────────────────────────────

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  serverId: uuid("server_id").references(() => servers.id),
  gameId: text("game_id").notNull(),
  workerUrl: text("worker_url"),
  status: text("status").notNull().default("pending"),
  // pending → ready → active → ended
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});
