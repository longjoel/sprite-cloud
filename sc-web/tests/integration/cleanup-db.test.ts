/**
 * Integration tests for cleanup ordering against real Postgres.
 *
 * Verifies FK-safe deletion order: children (launch_events, peer_tokens)
 * are deleted before parent rows (sessions, commands).
 *
 * Run: npx vitest run tests/integration/cleanup-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, getTestDb, resetTestDb } from "./test-db";
import { users, servers, commands, sessions, launchEvents, peerTokens } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { cleanupOnce } from "@/lib/db/cleanup";

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());
beforeEach(() => resetTestDb());

// ── Helpers ──────────────────────────────────────────────────────────────

async function seedUserAndServer() {
  const db = getTestDb();
  const [user] = await db.insert(users).values({ email: "test@example.com", name: "Tester" }).returning();
  const [server] = await db.insert(servers).values({
    userId: user.id, name: "test-server", apiKeyHash: "hash-" + Date.now(),
  }).returning();
  return { userId: user.id, serverId: server.id };
}

async function runCleanup() {
  await cleanupOnce(getTestDb() as any);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("Session timeout", () => {
  it("transitions stuck spawning session to timed_out", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();

    // Create a session stuck in spawning beyond the coordinated 13m timeout.
    const oldDate = new Date(Date.now() - 840_000); // 14 minutes ago
    await db.insert(sessions).values({
      userId, serverId, gameId: "smw", status: "spawning", stateEnteredAt: oldDate,
    });

    await runCleanup();

    const rows = await db.select().from(sessions);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("timed_out");
    expect(rows[0].endedAt).toBeInstanceOf(Date);
  });

  it("does not time out recent sessions", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();

    await db.insert(sessions).values({
      userId, serverId, gameId: "smw", status: "spawning",
      // stateEnteredAt defaults to now
    });

    await runCleanup();

    const rows = await db.select().from(sessions);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("spawning"); // still fresh
  });

  it("transitions stuck ready/connected to timed_out", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();
    const oldDate = new Date(Date.now() - 840_000);

    await db.insert(sessions).values({
      userId, serverId, gameId: "smw", status: "ready", stateEnteredAt: oldDate,
    });
    await db.insert(sessions).values({
      userId, serverId, gameId: "smb", status: "connected", stateEnteredAt: oldDate,
    });

    await runCleanup();

    const rows = await db.select().from(sessions);
    expect(rows.every(r => r.status === "timed_out")).toBe(true);
  });

  it("does not time out playing or ended sessions", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();
    const oldDate = new Date(Date.now() - 840_000);

    await db.insert(sessions).values({
      userId, serverId, gameId: "smw", status: "playing", stateEnteredAt: oldDate,
    });
    await db.insert(sessions).values({
      userId, serverId, gameId: "smb", status: "ended", stateEnteredAt: oldDate, endedAt: oldDate,
    });

    await runCleanup();

    const rows = await db.select().from(sessions);
    expect(rows.some(r => r.status === "playing")).toBe(true);
    expect(rows.some(r => r.status === "ended")).toBe(true);
  });

  it("does not time out a stale session while a lifecycle lease is still active", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();
    const oldDate = new Date(Date.now() - 840_000);
    const [session] = await db.insert(sessions).values({
      userId,
      serverId,
      gameId: "active-lease-game",
      status: "spawning",
      stateEnteredAt: oldDate,
    }).returning();
    const [command] = await db.insert(commands).values({
      serverId,
      type: "sdp_offer",
      payload: { game_id: "active-lease-game", session_id: session.id },
      status: "leased",
      leaseToken: "active-token",
      leaseExpiresAt: new Date(Date.now() + 120_000),
    }).returning();

    await runCleanup();

    let [keptSession] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    let [keptCommand] = await db.select().from(commands).where(eq(commands.id, command.id));
    expect(keptSession.status).toBe("spawning");
    expect(keptCommand.status).toBe("leased");

    await db.update(commands)
      .set({ leaseExpiresAt: oldDate })
      .where(eq(commands.id, command.id));
    await runCleanup();

    [keptSession] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    [keptCommand] = await db.select().from(commands).where(eq(commands.id, command.id));
    expect(keptSession.status).toBe("timed_out");
    expect(keptCommand.status).toBe("failed");
  });

  it("terminalizes lifecycle commands when their target session times out", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();
    const oldDate = new Date(Date.now() - 840_000);
    const [command] = await db.insert(commands).values({
      serverId,
      type: "sdp_offer",
      payload: {},
      status: "leased",
      leaseToken: "expired-token",
      leaseExpiresAt: oldDate,
    }).returning();
    const [session] = await db.insert(sessions).values({
      userId,
      serverId,
      gameId: "smw",
      commandId: command.id,
      status: "spawning",
      stateEnteredAt: oldDate,
    }).returning();
    await db.update(commands)
      .set({ payload: { game_id: "smw", session_id: session.id } })
      .where(eq(commands.id, command.id));
    await runCleanup();

    const [cleanedCommand] = await db.select().from(commands).where(eq(commands.id, command.id));
    expect(cleanedCommand.status).toBe("failed");
    expect(cleanedCommand.lastError).toBe("target session timed out");
    expect(cleanedCommand.leaseToken).toBeNull();
    const [cleanedSession] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(cleanedSession.status).toBe("timed_out");
  });

  it("keeps pending, expired-leased, and failed stops as durable runtime fences", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();
    const oldDate = new Date(Date.now() - 840_000);
    const [pendingSession] = await db.insert(sessions).values({
      userId, serverId, gameId: "pending-stop", status: "ready", stateEnteredAt: oldDate,
    }).returning();
    const [leasedSession] = await db.insert(sessions).values({
      userId, serverId, gameId: "leased-stop", status: "ready", stateEnteredAt: oldDate,
    }).returning();
    const [failedSession] = await db.insert(sessions).values({
      userId, serverId, gameId: "failed-stop", status: "ready", stateEnteredAt: oldDate,
    }).returning();
    const [pendingStop] = await db.insert(commands).values({
      serverId,
      type: "stop_game",
      payload: { game_id: "pending-stop", session_id: pendingSession.id },
      status: "pending",
    }).returning();
    const [legacyLeasedStop] = await db.insert(commands).values({
      serverId,
      type: "stop_game",
      payload: JSON.stringify({ game_id: "leased-stop", session_id: leasedSession.id }),
      status: "leased",
      leaseToken: "expired-stop-token",
      leaseExpiresAt: oldDate,
    }).returning();
    const [failedStop] = await db.insert(commands).values({
      serverId,
      type: "stop_game",
      payload: { game_id: "failed-stop", session_id: failedSession.id },
      status: "failed",
      completedAt: oldDate,
      lastError: "retry budget exhausted",
      createdAt: oldDate,
    }).returning();

    await runCleanup();

    const [keptPendingSession] = await db.select().from(sessions).where(eq(sessions.id, pendingSession.id));
    const [keptLeasedSession] = await db.select().from(sessions).where(eq(sessions.id, leasedSession.id));
    const [keptFailedSession] = await db.select().from(sessions).where(eq(sessions.id, failedSession.id));
    const [keptPendingStop] = await db.select().from(commands).where(eq(commands.id, pendingStop.id));
    const [keptLeasedStop] = await db.select().from(commands).where(eq(commands.id, legacyLeasedStop.id));
    const [keptFailedStop] = await db.select().from(commands).where(eq(commands.id, failedStop.id));
    expect(keptPendingSession.status).toBe("ready");
    expect(keptLeasedSession.status).toBe("ready");
    expect(keptFailedSession.status).toBe("ready");
    expect(keptPendingStop.status).toBe("pending");
    expect(keptLeasedStop.status).toBe("leased");
    expect(keptFailedStop.status).toBe("failed");
  });
});

describe("FK-safe cleanup ordering", () => {
  it("deletes launch_events before their parent session", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();

    // Create old session + launch events (past retention)
    const oldDate = new Date(Date.now() - 7_200_000); // 2 hours ago
    const [session] = await db.insert(sessions).values({
      userId, serverId, gameId: "smw", status: "ended",
      endedAt: oldDate, stateEnteredAt: oldDate, createdAt: oldDate,
    }).returning();

    await db.insert(launchEvents).values({
      sessionId: session.id,
      source: "server", event: "worker_spawned",
      createdAt: oldDate,
    });

    // Should not throw FK violation
    await expect(runCleanup()).resolves.not.toThrow();

    // Both should be cleaned up
    const sessionsLeft = await db.select().from(sessions);
    const eventsLeft = await db.select().from(launchEvents);
    expect(sessionsLeft.length).toBe(0);
    expect(eventsLeft.length).toBe(0);
  });

  it("deletes peer_tokens before their parent session", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();

    const oldDate = new Date(Date.now() - 7_200_000);
    const [session] = await db.insert(sessions).values({
      userId, serverId, gameId: "smw", status: "ended",
      endedAt: oldDate, stateEnteredAt: oldDate, createdAt: oldDate,
    }).returning();

    await db.insert(peerTokens).values({
      sessionId: session.id, token: "tk-" + Date.now(), seat: 0, role: "host",
    });

    await expect(runCleanup()).resolves.not.toThrow();

    const tokensLeft = await db.select().from(peerTokens);
    expect(tokensLeft.length).toBe(0);
  });

  it("does not delete commands still referenced by sessions", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();

    const oldDate = new Date(Date.now() - 7_200_000);
    const [cmd] = await db.insert(commands).values({
      serverId, type: "start_game", payload: { game_id: "smw" },
      status: "completed", completedAt: oldDate, createdAt: oldDate,
    }).returning();

    // Session still references the command
    await db.insert(sessions).values({
      userId, serverId, gameId: "smw", commandId: cmd.id,
      status: "playing", createdAt: oldDate, stateEnteredAt: oldDate,
    });

    await runCleanup();

    // Command should survive because a session still references it
    const cmdRows = await db.select().from(commands).where(eq(commands.id, cmd.id));
    expect(cmdRows.length).toBe(1);
  });
});

describe("Result-set cleanup", () => {
  it("keeps recent sessions and commands", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();

    // Recent session and command
    await db.insert(sessions).values({
      userId, serverId, gameId: "smw", status: "ended",
      endedAt: new Date(), stateEnteredAt: new Date(),
    });
    await db.insert(commands).values({
      serverId, type: "start_game", payload: {}, status: "completed",
    });

    await runCleanup();

    const sessionsLeft = await db.select().from(sessions);
    const commandsLeft = await db.select().from(commands);
    expect(sessionsLeft.length).toBe(1); // fresh, not deleted
    expect(commandsLeft.length).toBe(1);
  });

  it("does not delete old pending commands", async () => {
    const db = getTestDb();
    const { serverId } = await seedUserAndServer();
    const oldDate = new Date(Date.now() - 7_200_000);

    const [cmd] = await db.insert(commands).values({
      serverId,
      type: "start_game",
      payload: { game_id: "smw" },
      status: "pending",
      createdAt: oldDate,
    }).returning();

    await runCleanup();

    const commandsLeft = await db.select().from(commands).where(eq(commands.id, cmd.id));
    expect(commandsLeft.length).toBe(1);
    expect(commandsLeft[0].status).toBe("pending");
  });
});
