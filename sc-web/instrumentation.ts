/**
 * Next.js instrumentation hook — runs once at server startup.
 *
 * Imports the legacy first-run setup capability as the one-use bootstrap
 * invitation. Normal server invitations are created later by server admins.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {

  const fs = await import("fs");
  const crypto = await import("crypto");
  const path = "/tmp/sc-setup-code";
  let code: string;

  if (fs.existsSync(path)) {
    code = fs.readFileSync(path, "utf8").trim();
  } else {
    code = crypto.randomBytes(24).toString("base64url");
    fs.writeFileSync(path, code, { mode: 0o600 });
  }
  fs.chmodSync(path, 0o600);

  try {
    const [{ db }, { inviteCodes, users }, { eq, sql }] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/db/schema"),
      import("drizzle-orm"),
    ]);
    const [state] = await db.select({ userCount: sql<number>`count(*)` }).from(users);
    if (Number(state.userCount) !== 0) {
      fs.rmSync(path, { force: true });
      return;
    }

    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const [existing] = await db
      .select({ id: inviteCodes.id, codeHash: inviteCodes.codeHash })
      .from(inviteCodes)
      .where(eq(inviteCodes.kind, "bootstrap"))
      .limit(1);

    if (existing) {
      if (existing.codeHash !== codeHash) {
        await db.update(inviteCodes).set({
          codeHash,
          codePrefix: code.slice(0, 8),
          redemptionCount: 0,
          revokedAt: null,
          expiresAt: null,
        }).where(eq(inviteCodes.id, existing.id));
      }
    } else {
      await db.insert(inviteCodes).values({
        codeHash,
        codePrefix: code.slice(0, 8),
        kind: "bootstrap",
        serverId: null,
        createdBy: null,
        maxRedemptions: 1,
      });
    }

    console.log("");
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║              Sprite Cloud — First Run                          ║");
    console.log("╠════════════════════════════════════════════════════════════════╣");
    console.log(`║  Visit http://localhost:3000/invite/${code.padEnd(32)}  ║`);
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log("");
  } catch (error) {
    console.error("Failed to initialize first-run bootstrap invitation:", error);
  }
  }
}
