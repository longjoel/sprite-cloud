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

type AccountDeletionBlock = {
  serverIds?: string[];
  activeSessionIds?: string[];
};

export class AccountDeletionBlockedError extends Error {
  readonly serverIds: string[];
  readonly activeSessionIds: string[];

  constructor({ serverIds = [], activeSessionIds = [] }: AccountDeletionBlock) {
    super(
      activeSessionIds.length > 0
        ? "end active sessions before deleting the account"
        : "account owns servers that must be transferred or deleted first",
    );
    this.name = "AccountDeletionBlockedError";
    this.serverIds = serverIds;
    this.activeSessionIds = activeSessionIds;
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

    return {
      account,
      memberships,
      ownedServers,
      pairingCodes: accountPairingCodes,
      createdInvites,
      inviteRedemptions: accountInviteRedemptions,
      shortCodes: accountShortCodes,
      sessions: accountSessions,
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
      sql`${commands.payload}->>'user_id' = ${userId}`,
      sql`${commands.payload}->>'authorized_user_id' = ${userId}`,
    ];
    if (sessionCommandIds.length > 0) {
      commandOwnership.push(inArray(commands.id, sessionCommandIds));
    }
    if (sessionIds.length > 0) {
      commandOwnership.push(sql`${commands.payload}->>'session_id' IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})`);
    }
    const associatedCommands = await tx
      .select({ id: commands.id })
      .from(commands)
      .where(or(...commandOwnership));
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

    await tx.execute(sql`DELETE FROM favorites WHERE user_id = ${userId}`);
    await tx.execute(sql`DELETE FROM recent_plays WHERE user_id = ${userId}`);
    await tx.delete(shortCodes).where(eq(shortCodes.createdBy, userId));
    await tx.delete(pairingCodes).where(eq(pairingCodes.userId, userId));
    await tx.delete(inviteRedemptions).where(eq(inviteRedemptions.userId, userId));
    await tx.delete(serverMembers).where(eq(serverMembers.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
}
