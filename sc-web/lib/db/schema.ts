import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, integer, index } from "drizzle-orm/pg-core";

// ── Users (created via OAuth) ────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Servers (sc-server instances, paired via code) ───────────────────

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

// ── Server game catalog (pushed by sc-server, cached on sc-web) ──────
//
// sc-server is the source of truth; this table is a read-only search index.
// ROM paths, file hashes, and library preferences stay on sc-server.

export const serverGames = pgTable("server_games", {
  serverId: uuid("server_id")
    .references(() => servers.id, { onDelete: "cascade" })
    .notNull(),
  gameId: text("game_id").notNull(),
  name: text("name").notNull(),
  platform: text("platform").notNull().default("Unknown"),
  maxPlayers: integer("max_players").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: unique("server_games_pkey").on(table.serverId, table.gameId),
  serverIdx: index("idx_server_games_server").on(table.serverId),
  nameIdx: index("idx_server_games_name").on(table.name),
}));

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

// ── Enrollment invite codes (server-admin managed capabilities) ────────

export const inviteCodes = pgTable(
  "invite_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codeHash: text("code_hash").notNull().unique(),
    codePrefix: text("code_prefix").notNull(),
    kind: text("kind").notNull().default("server"),
    serverId: uuid("server_id")
      .references(() => servers.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .references(() => users.id),
    maxRedemptions: integer("max_redemptions").notNull().default(1),
    redemptionCount: integer("redemption_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    serverCreatedIdx: index("idx_invite_codes_server_created").on(table.serverId, table.createdAt),
    oneBootstrapIdx: uniqueIndex("idx_invite_codes_one_bootstrap")
      .on(table.kind)
      .where(sql`${table.kind} = 'bootstrap'`),
    maxPositive: check("invite_codes_max_positive", sql`${table.maxRedemptions} > 0`),
    redemptionNonnegative: check("invite_codes_redemption_nonnegative", sql`${table.redemptionCount} >= 0`),
    redemptionWithinMax: check("invite_codes_redemption_within_max", sql`${table.redemptionCount} <= ${table.maxRedemptions}`),
    resourceShape: check(
      "invite_codes_resource_shape",
      sql`(${table.kind} = 'server' AND ${table.serverId} IS NOT NULL AND ${table.createdBy} IS NOT NULL) OR (${table.kind} = 'bootstrap' AND ${table.serverId} IS NULL AND ${table.createdBy} IS NULL AND ${table.maxRedemptions} = 1)`,
    ),
  }),
);

export const inviteRedemptions = pgTable(
  "invite_redemptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    inviteCodeId: uuid("invite_code_id")
      .references(() => inviteCodes.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    inviteUserUnique: unique("invite_redemptions_invite_user").on(table.inviteCodeId, table.userId),
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

// ── Command queue (sc-server polls for pending work) ──────────────────
//
// Commands are transient — created by browser users, leased by sc-server,
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
  sdpAnswer: text("sdp_answer"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("uq_commands_active_upgrade_per_server")
    .on(table.serverId)
    .where(sql`${table.type} = 'upgrade_server' AND ${table.status} IN ('pending', 'leased')`),
]);

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
  generation: integer("generation").notNull().default(1),
  status: text("status").notNull().default("spawning"),
  // spawning → ready → connected → playing → ended | timed_out
  stateEnteredAt: timestamp("state_entered_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

// ── Launch timeline events ────────────────────────────────────────────
//
// One row per observable launch/connect milestone. These rows are for
// diagnostics only: never store credentials, bearer tokens, SDP blobs, or
// other sensitive payloads in `detail`.

export const launchEvents = pgTable(
  "launch_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id").references(() => sessions.id),
    commandId: uuid("command_id").references(() => commands.id),
    serverId: uuid("server_id").references(() => servers.id),
    gameId: text("game_id"),
    source: text("source").notNull(),
    event: text("event").notNull(),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    idxSessionCreated: index("idx_launch_events_session_created").on(table.sessionId, table.createdAt),
    idxCommandCreated: index("idx_launch_events_command_created").on(table.commandId, table.createdAt),
  }),
);


// ── Peer tokens (per-peer bearer tokens for WebRTC auth) ─────────────
//
// Issued when a session starts (host) or a guest joins via room_token.
// Each peer gets a unique token, seat, and role. The worker validates
// tokens before accepting SDP offers.

export const peerTokens = pgTable(
  "peer_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .references(() => sessions.id)
      .notNull(),
    token: text("token").notNull().unique(),       // 32-char hex
    seat: integer("seat").notNull(),               // 0=host, 1..N=players/watchers
    role: text("role").notNull().default("viewer"), // host | player | viewer
    clientId: text("client_id"),                   // stable browser-tab id for idempotent guest reconnects
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    sessionClient: unique("peer_tokens_session_client").on(table.sessionId, table.clientId),
  }),
);

// ── Short codes (URL-shortener for player reconnection links) ──────────
//
// Host launches and private room invitations use 16-char (80-bit) codes.
// The legacy host_token column stores either the UUID-shaped host capability
// or the rotating 32-hex room capability; the resolver keeps their roles apart.

export const shortCodes = pgTable("short_codes", {
  code: text("code").primaryKey(),
  gameId: text("game_id").notNull(),
  hostToken: text("host_token").notNull(),
  serverId: text("server_id").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
