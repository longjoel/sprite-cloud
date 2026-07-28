import { createHash, randomBytes } from "node:crypto";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { inviteCodes, inviteRedemptions, serverMembers, users } from "@/lib/db/schema";

export function hashInviteCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function generateInviteCode(): { code: string; codeHash: string } {
  const code = randomBytes(24).toString("base64url");
  return { code, codeHash: hashInviteCode(code) };
}

export async function requireServerAdmin(userId: string, serverId: string): Promise<boolean> {
  const [membership] = await db
    .select({ id: serverMembers.id })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.userId, userId),
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.role, "admin"),
    ))
    .limit(1);
  return Boolean(membership);
}

export function inviteUnavailableReason(invite: {
  revokedAt: Date | null;
  expiresAt: Date | null;
  redemptionCount: number;
  maxRedemptions: number;
}, now = new Date()): "revoked" | "expired" | "exhausted" | null {
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt && invite.expiresAt <= now) return "expired";
  if (invite.redemptionCount >= invite.maxRedemptions) return "exhausted";
  return null;
}

export class InviteRedemptionError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface RedemptionInput {
  codeHash: string;
  name: string;
  email: string;
  passwordHash: string;
}

function hasPostgresCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === code) return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

export async function redeemInviteAccount(database: typeof db, input: RedemptionInput) {
  try {
    return await database.transaction(async (tx) => {
      const [invite] = await tx
        .select({
          ...getTableColumns(inviteCodes),
          expiredAtDatabaseTime: sql<boolean>`${inviteCodes.expiresAt} IS NOT NULL AND ${inviteCodes.expiresAt} <= now()`,
        })
        .from(inviteCodes)
        .where(eq(inviteCodes.codeHash, input.codeHash))
        .for("update")
        .limit(1);
      if (!invite) throw new InviteRedemptionError(404, "invite not found");
      if (invite.revokedAt) throw new InviteRedemptionError(410, "invite revoked");
      if (invite.expiredAtDatabaseTime) throw new InviteRedemptionError(410, "invite expired");
      if (invite.redemptionCount >= invite.maxRedemptions) {
        throw new InviteRedemptionError(410, "invite exhausted");
      }
      if (invite.kind === "bootstrap") {
        const [state] = await tx.select({ userCount: sql<number>`count(*)` }).from(users);
        if (Number(state.userCount) !== 0) {
          throw new InviteRedemptionError(410, "bootstrap invite unavailable");
        }
      }

      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);
      if (existing) throw new InviteRedemptionError(409, "email already registered");

      const [created] = await tx
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash: input.passwordHash })
        .returning({ id: users.id, email: users.email, name: users.name });

      if (invite.serverId) {
        await tx.insert(serverMembers).values({
          serverId: invite.serverId,
          userId: created.id,
          role: "member",
        });
      }
      await tx.insert(inviteRedemptions).values({
        inviteCodeId: invite.id,
        userId: created.id,
      });
      const [updated] = await tx
        .update(inviteCodes)
        .set({ redemptionCount: invite.redemptionCount + 1 })
        .where(and(
          eq(inviteCodes.id, invite.id),
          eq(inviteCodes.redemptionCount, invite.redemptionCount),
        ))
        .returning({ id: inviteCodes.id });
      if (!updated) throw new InviteRedemptionError(409, "invite was redeemed concurrently");

      return { user: created, serverId: invite.serverId };
    });
  } catch (error) {
    if (error instanceof InviteRedemptionError) throw error;
    if (hasPostgresCode(error, "23505")) {
      throw new InviteRedemptionError(409, "email already registered");
    }
    throw error;
  }
}
