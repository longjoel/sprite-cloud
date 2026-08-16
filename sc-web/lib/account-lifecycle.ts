import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  users,
  servers,
  serverMembers,
  inviteCodes,
  inviteRedemptions,
  pairingCodes,
  sessions,
  peerTokens,
  launchEvents,
  shortCodes,
} from "@/lib/db/schema";

type AccountLifecycleDb = typeof db;
const ACTIVE_SESSION_STATUSES = ["spawning", "ready", "connected", "playing"] as const;

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
        sessions: [],
      };
    }

    const [memberships, ownedServers, accountPairingCodes, createdInvites, accountSessions] = await Promise.all([
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
      .select({ id: sessions.id, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .for("update");
    const activeSessionIds = accountSessions
      .filter((session) => ACTIVE_SESSION_STATUSES.includes(session.status as (typeof ACTIVE_SESSION_STATUSES)[number]))
      .map((session) => session.id);
    if (activeSessionIds.length > 0) {
      throw new AccountDeletionBlockedError({ activeSessionIds });
    }

    const sessionIds = accountSessions.map((session) => session.id);

    if (sessionIds.length > 0) {
      await tx.delete(peerTokens).where(inArray(peerTokens.sessionId, sessionIds));
      await tx.delete(launchEvents).where(inArray(launchEvents.sessionId, sessionIds));
      await tx.delete(sessions).where(inArray(sessions.id, sessionIds));
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
    await tx.delete(serverMembers).where(eq(serverMembers.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
}
