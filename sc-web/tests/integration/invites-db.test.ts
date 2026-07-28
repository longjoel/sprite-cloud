import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, teardownTestDb, getTestDb, resetTestDb } from "./test-db";
import { inviteCodes, inviteRedemptions, serverMembers, servers, users } from "@/lib/db/schema";
import { generateInviteCode, redeemInviteAccount } from "@/lib/invites";

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());
beforeEach(() => resetTestDb());

async function seedInvite(maxRedemptions = 1, expiresAt: Date | null = null) {
  const db = getTestDb() as unknown as typeof import("@/lib/db").db;
  const [owner] = await db.insert(users).values({ email: "owner@example.com", name: "Owner" }).returning();
  const [server] = await db.insert(servers).values({ userId: owner.id, name: "Arcade", apiKeyHash: "server-key" }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "admin" });
  const generated = generateInviteCode();
  const [invite] = await db.insert(inviteCodes).values({
    codeHash: generated.codeHash,
    codePrefix: generated.code.slice(0, 8),
    kind: "server",
    serverId: server.id,
    createdBy: owner.id,
    maxRedemptions,
    expiresAt,
  }).returning();
  return { db, server, invite, ...generated };
}

describe("invite enrollment transactions", () => {
  it("serializes first-run bootstrap enrollment to exactly one account", async () => {
    const db = getTestDb() as unknown as typeof import("@/lib/db").db;
    const generated = generateInviteCode();
    const [invite] = await db.insert(inviteCodes).values({
      codeHash: generated.codeHash,
      codePrefix: generated.code.slice(0, 8),
      kind: "bootstrap",
      serverId: null,
      createdBy: null,
      maxRedemptions: 1,
    }).returning();

    const attempts = await Promise.allSettled([
      redeemInviteAccount(db, { codeHash: generated.codeHash, name: "First", email: "first@example.com", passwordHash: "hash-a" }),
      redeemInviteAccount(db, { codeHash: generated.codeHash, name: "Second", email: "second@example.com", passwordHash: "hash-b" }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(serverMembers)).toHaveLength(0);
    expect(await db.select().from(inviteRedemptions).where(eq(inviteRedemptions.inviteCodeId, invite.id))).toHaveLength(1);
    const [updated] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, invite.id));
    expect(updated.redemptionCount).toBe(1);
  });

  it("allows exactly N concurrent redemptions of an N-use invitation", async () => {
    const { db, codeHash, invite, server } = await seedInvite(3);
    const attempts = await Promise.allSettled([
      redeemInviteAccount(db, { codeHash, name: "A", email: "a@example.com", passwordHash: "hash-a" }),
      redeemInviteAccount(db, { codeHash, name: "B", email: "b@example.com", passwordHash: "hash-b" }),
      redeemInviteAccount(db, { codeHash, name: "C", email: "c@example.com", passwordHash: "hash-c" }),
      redeemInviteAccount(db, { codeHash, name: "D", email: "d@example.com", passwordHash: "hash-d" }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(3);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(inviteRedemptions).where(eq(inviteRedemptions.inviteCodeId, invite.id))).toHaveLength(3);
    expect(await db.select().from(serverMembers).where(eq(serverMembers.serverId, server.id))).toHaveLength(4);
    const [updated] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, invite.id));
    expect(updated.redemptionCount).toBe(3);
  });

  it("rejects expired invitations without creating an account", async () => {
    const { db, codeHash } = await seedInvite(2, new Date(Date.now() - 1000));
    await expect(redeemInviteAccount(db, {
      codeHash,
      name: "Late",
      email: "late@example.com",
      passwordHash: "hash",
    })).rejects.toMatchObject({ status: 410, message: "invite expired" });
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("maps concurrent same-email redemption across different invites to one stable conflict", async () => {
    const { db, server, invite: firstInvite, codeHash: firstHash } = await seedInvite(1);
    const secondCode = generateInviteCode();
    const [secondInvite] = await db.insert(inviteCodes).values({
      codeHash: secondCode.codeHash,
      codePrefix: secondCode.code.slice(0, 8),
      kind: "server",
      serverId: server.id,
      createdBy: firstInvite.createdBy,
      maxRedemptions: 1,
    }).returning();

    const attempts = await Promise.allSettled([
      redeemInviteAccount(db, { codeHash: firstHash, name: "Same", email: "same@example.com", passwordHash: "hash-a" }),
      redeemInviteAccount(db, { codeHash: secondCode.codeHash, name: "Same", email: "same@example.com", passwordHash: "hash-b" }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, message: "email already registered" });
    expect(await db.select().from(users)).toHaveLength(2);
    expect(await db.select().from(inviteRedemptions)).toHaveLength(1);
    expect(await db.select().from(serverMembers).where(eq(serverMembers.serverId, server.id))).toHaveLength(2);
    const inviteRows = await db.select().from(inviteCodes);
    expect(inviteRows.find((row) => row.id === firstInvite.id)!.redemptionCount
      + inviteRows.find((row) => row.id === secondInvite.id)!.redemptionCount).toBe(1);
  });
});
