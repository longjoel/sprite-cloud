import { eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  users,
  servers,
  serverMembers,
  inviteCodes,
  inviteRedemptions,
  pairingCodes,
  commands,
  sessions,
  peerTokens,
  launchEvents,
  shortCodes,
} from "@/lib/db/schema";

type AccountLifecycleDb = typeof db;
const TERMINAL_SESSION_STATUSES = ["ended", "timed_out"] as const;

async function legacyUserCollections(tx: any, userId: string) {
  const tables = await tx.execute(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('favorites', 'recent_plays', 'pinned_games')
  `) as unknown as Array<{ table_name: string }>;
  const present = new Set(tables.map((row) => row.table_name));
  const result: {
    favorites: Array<Record<string, unknown>>;
    recentPlays: Array<Record<string, unknown>>;
    pinnedGames: Array<Record<string, unknown>>;
  } = { favorites: [], recentPlays: [], pinnedGames: [] };
  if (present.has("favorites")) {
    result.favorites = [...await tx.execute(sql`SELECT game_id, created_at FROM favorites WHERE user_id = ${userId}`) as unknown as Array<Record<string, unknown>>];
  }
  if (present.has("recent_plays")) {
    result.recentPlays = [...await tx.execute(sql`SELECT id, game_id, played_at FROM recent_plays WHERE user_id = ${userId}`) as unknown as Array<Record<string, unknown>>];
  }
  if (present.has("pinned_games")) {
    result.pinnedGames = [...await tx.execute(sql`SELECT game_id, position, created_at FROM pinned_games WHERE user_id = ${userId}`) as unknown as Array<Record<string, unknown>>];
  }
  return result;
}

type AccountDeletionBlock = {
  serverIds?: string[];
  activeSessionIds?: string[];
  pendingCommandIds?: string[];
};

const TERMINAL_COMMAND_STATUSES = ["completed", "failed", "cancelled"] as const;

export class AccountDeletionBlockedError extends Error {
  readonly serverIds: string[];
  readonly activeSessionIds: string[];
  readonly pendingCommandIds: string[];

  constructor({ serverIds = [], activeSessionIds = [], pendingCommandIds = [] }: AccountDeletionBlock) {
    super(
      pendingCommandIds.length > 0
        ? "wait for queued commands to reach a terminal state before deleting the account"
        : activeSessionIds.length > 0
        ? "end active sessions before deleting the account"
        : "account owns servers that must be transferred or deleted first",
    );
    this.name = "AccountDeletionBlockedError";
    this.serverIds = serverIds;
    this.activeSessionIds = activeSessionIds;
    this.pendingCommandIds = pendingCommandIds;
  }
}

export async function exportAccountData(database: AccountLifecycleDb, userId: string) {
  return database.transaction(async (tx) => {
    const [account] = await tx
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!account) {
      return {
        account: null,
        memberships: [],
        ownedServers: [],
        pairingCodes: [],
        createdInvites: [],
        inviteRedemptions: [],
        shortCodes: [],
        sessions: [],
        favorites: [],
        recentPlays: [],
        pinnedGames: [],
      };
    }

    const [memberships, ownedServers, accountPairingCodes, createdInvites, accountInviteRedemptions, accountShortCodes, accountSessions] = await Promise.all([
      tx
        .select({ serverId: serverMembers.serverId, role: serverMembers.role, createdAt: serverMembers.createdAt })
        .from(serverMembers)
        .where(eq(serverMembers.userId, userId)),
      tx
        .select({ id: servers.id, name: servers.name, createdAt: servers.createdAt, lastSeenAt: servers.lastSeenAt })
        .from(servers)
        .where(eq(servers.userId, userId)),
      tx
        .select({ status: pairingCodes.status, expiresAt: pairingCodes.expiresAt, claimedAt: pairingCodes.claimedAt, createdAt: pairingCodes.createdAt })
        .from(pairingCodes)
        .where(eq(pairingCodes.userId, userId)),
      tx
        .select({ id: inviteCodes.id, codePrefix: inviteCodes.codePrefix, kind: inviteCodes.kind, serverId: inviteCodes.serverId, maxRedemptions: inviteCodes.maxRedemptions, redemptionCount: inviteCodes.redemptionCount, expiresAt: inviteCodes.expiresAt, revokedAt: inviteCodes.revokedAt, createdAt: inviteCodes.createdAt })
        .from(inviteCodes)
        .where(eq(inviteCodes.createdBy, userId)),
      tx
        .select({ id: inviteRedemptions.id, inviteCodeId: inviteRedemptions.inviteCodeId, redeemedAt: inviteRedemptions.redeemedAt })
        .from(inviteRedemptions)
        .where(eq(inviteRedemptions.userId, userId)),
      tx
        .select({ code: shortCodes.code, gameId: shortCodes.gameId, serverId: shortCodes.serverId, mintedViaProxy: shortCodes.mintedViaProxy })
        .from(shortCodes)
        .where(eq(shortCodes.createdBy, userId)),
      tx
        .select({ id: sessions.id, serverId: sessions.serverId, commandId: sessions.commandId, gameId: sessions.gameId, maxSeats: sessions.maxSeats, generation: sessions.generation, status: sessions.status, stateEnteredAt: sessions.stateEnteredAt, createdAt: sessions.createdAt, endedAt: sessions.endedAt })
        .from(sessions)
        .where(eq(sessions.userId, userId)),
    ]);
    const legacy = await legacyUserCollections(tx, userId);

    return {
      account,
      memberships,
      ownedServers,
      pairingCodes: accountPairingCodes,
      createdInvites,
      inviteRedemptions: accountInviteRedemptions,
      shortCodes: accountShortCodes,
      sessions: accountSessions,
      ...legacy,
    };
  }, { isolationLevel: "repeatable read" });
}

export async function deleteAccount(database: AccountLifecycleDb, userId: string): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");

    const owned = await tx
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.userId, userId))
      .for("update");

    if (owned.length > 0) {
      throw new AccountDeletionBlockedError({ serverIds: owned.map((server) => server.id) });
    }

    const accountSessions = await tx
      .select({ id: sessions.id, status: sessions.status, commandId: sessions.commandId })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .for("update");
    const activeSessionIds = accountSessions
      .filter((session) => !TERMINAL_SESSION_STATUSES.includes(session.status as (typeof TERMINAL_SESSION_STATUSES)[number]))
      .map((session) => session.id);
    if (activeSessionIds.length > 0) {
      throw new AccountDeletionBlockedError({ activeSessionIds });
    }

    const sessionIds = accountSessions.map((session) => session.id);
    const sessionCommandIds = accountSessions
      .map((session) => session.commandId)
      .filter((commandId): commandId is string => !!commandId);
    const commandOwnership = [
      sql`jsonb_typeof(${commands.payload}) = 'object' AND ${commands.payload}->>'user_id' = ${userId}`,
      sql`jsonb_typeof(${commands.payload}) = 'object' AND ${commands.payload}->>'authorized_user_id' = ${userId}`,
      sql`(CASE WHEN jsonb_typeof(${commands.payload}) = 'string' THEN ((${commands.payload}#>>'{}')::jsonb ->> 'user_id') END) = ${userId}`,
      sql`(CASE WHEN jsonb_typeof(${commands.payload}) = 'string' THEN ((${commands.payload}#>>'{}')::jsonb ->> 'authorized_user_id') END) = ${userId}`,
    ];
    if (sessionCommandIds.length > 0) {
      commandOwnership.push(inArray(commands.id, sessionCommandIds));
    }
    if (sessionIds.length > 0) {
      const objectSessionOwnership = sql`jsonb_typeof(${commands.payload}) = 'object' AND ${commands.payload}->>'session_id' IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})`;
      const stringSessionOwnership = or(...sessionIds.map((sessionId) => sql`(CASE WHEN jsonb_typeof(${commands.payload}) = 'string' THEN ((${commands.payload}#>>'{}')::jsonb ->> 'session_id') END) = ${sessionId}`))!;
      commandOwnership.push(or(objectSessionOwnership, stringSessionOwnership)!);
    }
    const associatedCommands = await tx
      .select({ id: commands.id, status: commands.status })
      .from(commands)
      .where(or(...commandOwnership));
    const pendingCommandIds = associatedCommands
      .filter((command) => !TERMINAL_COMMAND_STATUSES.includes(command.status as (typeof TERMINAL_COMMAND_STATUSES)[number]))
      .map((command) => command.id);
    if (pendingCommandIds.length > 0) {
      throw new AccountDeletionBlockedError({ pendingCommandIds });
    }
    const commandIds = associatedCommands.map((command) => command.id);

    if (sessionIds.length > 0) {
      await tx.delete(peerTokens).where(inArray(peerTokens.sessionId, sessionIds));
      await tx.delete(launchEvents).where(
        or(
          inArray(launchEvents.sessionId, sessionIds),
          commandIds.length > 0 ? inArray(launchEvents.commandId, commandIds) : sql`false`,
        ),
      );
      await tx.delete(sessions).where(inArray(sessions.id, sessionIds));
    } else if (commandIds.length > 0) {
      await tx.delete(launchEvents).where(inArray(launchEvents.commandId, commandIds));
    }
    if (commandIds.length > 0) {
      await tx.delete(commands).where(inArray(commands.id, commandIds));
    }

    const createdInvites = await tx
      .select({ id: inviteCodes.id })
      .from(inviteCodes)
      .where(eq(inviteCodes.createdBy, userId));
    const inviteIds = createdInvites.map((invite) => invite.id);
    if (inviteIds.length > 0) {
      await tx.delete(inviteRedemptions).where(inArray(inviteRedemptions.inviteCodeId, inviteIds));
      await tx.delete(inviteCodes).where(inArray(inviteCodes.id, inviteIds));
    }

    await tx.delete(shortCodes).where(eq(shortCodes.createdBy, userId));
    await tx.delete(pairingCodes).where(eq(pairingCodes.userId, userId));
    await tx.delete(inviteRedemptions).where(eq(inviteRedemptions.userId, userId));
    const legacyTables = await tx.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('favorites', 'recent_plays', 'pinned_games')
    `) as unknown as Array<{ table_name: string }>;
    const legacyTableNames = new Set(legacyTables.map((row) => row.table_name));
    if (legacyTableNames.has("favorites")) {
      await tx.execute(sql`DELETE FROM favorites WHERE user_id = ${sql`${userId}::uuid`}`);
    }
    if (legacyTableNames.has("recent_plays")) {
      await tx.execute(sql`DELETE FROM recent_plays WHERE user_id = ${sql`${userId}::uuid`}`);
    }
    if (legacyTableNames.has("pinned_games")) {
      await tx.execute(sql`DELETE FROM pinned_games WHERE user_id = ${sql`${userId}::uuid`}`);
    }
    await tx.delete(serverMembers).where(eq(serverMembers.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
}
