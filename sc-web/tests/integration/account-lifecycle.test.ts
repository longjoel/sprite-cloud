/**
 * #665 account export/deletion contract against real Postgres.
 *
 * Run: pnpm exec vitest run tests/integration/account-lifecycle.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, getTestDb, resetTestDb } from "./test-db";
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
import { eq } from "drizzle-orm";
import { exportAccountData, deleteAccount, AccountDeletionBlockedError } from "@/lib/account-lifecycle";

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());
beforeEach(() => resetTestDb());

async function seedAccountGraph() {
  const db = getTestDb();
  const [owner] = await db.insert(users).values({
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "must-not-export",
  }).returning();
  const [other] = await db.insert(users).values({
    email: "other@example.com",
    name: "Other",
    passwordHash: "other-secret",
  }).returning();
  const [server] = await db.insert(servers).values({
    userId: owner.id,
    name: "Owner server",
    apiKeyHash: "server-api-key-hash",
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "admin" },
    { serverId: server.id, userId: other.id, role: "member" },
  ]);
  const [invite] = await db.insert(inviteCodes).values({
    codeHash: "invite-hash",
    codePrefix: "INVITE",
    serverId: server.id,
    createdBy: owner.id,
  }).returning();
  await db.insert(inviteRedemptions).values({ inviteCodeId: invite.id, userId: other.id });
  await db.insert(pairingCodes).values({
    code: "PAIRING",
    userId: owner.id,
    status: "claimed",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const [command] = await db.insert(commands).values({
    serverId: server.id,
    type: "start_game",
    payload: { game_id: "fixture" },
    status: "completed",
  }).returning();
  const [session] = await db.insert(sessions).values({
    userId: owner.id,
    serverId: server.id,
    commandId: command.id,
    gameId: "fixture",
    hostToken: "host-capability",
    roomToken: "room-capability",
    status: "ended",
    endedAt: new Date(),
  }).returning();
  await db.insert(peerTokens).values({
    sessionId: session.id,
    token: "peer-secret",
    seat: 0,
    role: "host",
  });
  await db.insert(launchEvents).values({
    sessionId: session.id,
    commandId: command.id,
    serverId: server.id,
    gameId: "fixture",
    source: "browser",
    event: "ended",
    detail: { safe: true },
  });
  await db.insert(shortCodes).values({
    code: "SHORTCODE",
    gameId: "fixture",
    hostToken: "short-code-secret",
    serverId: server.id,
    createdBy: owner.id,
  });
  return { owner, other, server, invite, command, session };
}

describe("exportAccountData", () => {
  it("exports only the account's records and never secrets or another user's data", async () => {
    const graph = await seedAccountGraph();

    const exported = await exportAccountData(getTestDb(), graph.owner.id);

    expect(exported.account).toMatchObject({
      id: graph.owner.id,
      email: "owner@example.com",
      name: "Owner",
    });
    expect(JSON.stringify(exported)).not.toContain("must-not-export");
    expect(JSON.stringify(exported)).not.toContain("server-api-key-hash");
    expect(JSON.stringify(exported)).not.toContain("host-capability");
    expect(JSON.stringify(exported)).not.toContain("peer-secret");
    expect(JSON.stringify(exported)).not.toContain("PAIRING");
    expect(JSON.stringify(exported)).not.toContain("short-code-secret");
    expect(JSON.stringify(exported)).not.toContain("other@example.com");
    expect(exported.memberships).toHaveLength(1);
    expect(exported.ownedServers).toHaveLength(1);
    expect(exported.pairingCodes).toHaveLength(1);
    expect(exported.createdInvites).toHaveLength(1);
    expect(exported.sessions).toHaveLength(1);
  });

  it("does not disclose whether a different user's account exists", async () => {
    const graph = await seedAccountGraph();

    const exported = await exportAccountData(getTestDb(), "00000000-0000-0000-0000-000000000001");

    expect(exported).toEqual({
      account: null,
      memberships: [],
      ownedServers: [],
      pairingCodes: [],
      createdInvites: [],
      sessions: [],
    });
    expect(exported).not.toHaveProperty("other");
    expect(graph.other.email).toBe("other@example.com");
  });
});

describe("deleteAccount", () => {
  it("fails closed while the account owns a server", async () => {
    const graph = await seedAccountGraph();

    await expect(deleteAccount(getTestDb(), graph.owner.id)).rejects.toBeInstanceOf(AccountDeletionBlockedError);

    expect((await getTestDb().select().from(users).where(eq(users.id, graph.owner.id)))).toHaveLength(1);
    expect((await getTestDb().select().from(servers).where(eq(servers.id, graph.server.id)))).toHaveLength(1);
  });

  it("removes the account's owned lifecycle records after server ownership is resolved", async () => {
    const graph = await seedAccountGraph();
    await getTestDb().update(servers).set({ userId: graph.other.id }).where(eq(servers.id, graph.server.id));

    await deleteAccount(getTestDb(), graph.owner.id);

    expect((await getTestDb().select().from(users).where(eq(users.id, graph.owner.id)))).toHaveLength(0);
    expect((await getTestDb().select().from(serverMembers).where(eq(serverMembers.userId, graph.owner.id)))).toHaveLength(0);
    expect((await getTestDb().select().from(pairingCodes).where(eq(pairingCodes.userId, graph.owner.id)))).toHaveLength(0);
    expect((await getTestDb().select().from(sessions).where(eq(sessions.id, graph.session.id)))).toHaveLength(0);
    expect((await getTestDb().select().from(peerTokens).where(eq(peerTokens.sessionId, graph.session.id)))).toHaveLength(0);
    expect((await getTestDb().select().from(launchEvents).where(eq(launchEvents.sessionId, graph.session.id)))).toHaveLength(0);
    expect((await getTestDb().select().from(shortCodes).where(eq(shortCodes.createdBy, graph.owner.id)))).toHaveLength(0);
    expect((await getTestDb().select().from(inviteCodes).where(eq(inviteCodes.createdBy, graph.owner.id)))).toHaveLength(0);
    expect((await getTestDb().select().from(servers).where(eq(servers.id, graph.server.id)))).toHaveLength(1);
    expect((await getTestDb().select().from(users).where(eq(users.id, graph.other.id)))).toHaveLength(1);
  });

  it("deletes a non-owner account without deleting the shared server or its owner", async () => {
    const graph = await seedAccountGraph();

    await deleteAccount(getTestDb(), graph.other.id);

    expect((await getTestDb().select().from(users).where(eq(users.id, graph.other.id)))).toHaveLength(0);
    expect((await getTestDb().select().from(users).where(eq(users.id, graph.owner.id)))).toHaveLength(1);
    expect((await getTestDb().select().from(servers).where(eq(servers.id, graph.server.id)))).toHaveLength(1);
    expect((await getTestDb().select().from(serverMembers).where(eq(serverMembers.userId, graph.other.id)))).toHaveLength(0);
    expect((await getTestDb().select().from(inviteRedemptions).where(eq(inviteRedemptions.userId, graph.other.id)))).toHaveLength(0);
  });
});
