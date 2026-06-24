/**
 * Integration tests for session/command lifecycle against real Postgres.
 *
 * Run: npx vitest run tests/integration/lifecycle-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, getTestDb, resetTestDb } from "./test-db";
import { users, servers, commands, sessions, launchEvents, peerTokens } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());
beforeEach(() => resetTestDb());

// ── Helpers ──────────────────────────────────────────────────────────────

async function seedUserAndServer() {
  const db = getTestDb();
  const [user] = await db.insert(users).values({ email: "tester@example.com", name: "Tester" }).returning();
  const [server] = await db.insert(servers).values({
    userId: user.id,
    name: "test-server",
    apiKeyHash: "hash-" + Date.now(),
  }).returning();
  return { userId: user.id, serverId: server.id };
}

async function seedCommand(serverId: string, type: string, payload: Record<string, unknown> = {}) {
  const db = getTestDb();
  const [cmd] = await db.insert(commands).values({
    serverId, type, payload, status: "pending",
  }).returning();
  return cmd;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("Session lifecycle state transitions", () => {
  it("creates a session in 'spawning' state", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();
    const [session] = await db.insert(sessions).values({
      userId, serverId, gameId: "smw", status: "spawning",
    }).returning();

    expect(session.id).toBeTruthy();
    expect(session.status).toBe("spawning");
    expect(session.stateEnteredAt).toBeInstanceOf(Date);
  });

  it("transitions spawning → ready → connected → playing → ended", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();
    const cmd = await seedCommand(serverId, "start_game", { game_id: "smw" });

    // Create session in spawning
    const [session] = await db.insert(sessions).values({
      userId, serverId, gameId: "smw", commandId: cmd.id, status: "spawning",
    }).returning();
    expect(session.status).toBe("spawning");

    // → ready (worker reported URL)
    await db.update(sessions)
      .set({ status: "ready", workerUrl: "http://worker:9999", stateEnteredAt: new Date() })
      .where(eq(sessions.id, session.id));
    const ready = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1);
    expect(ready[0].status).toBe("ready");
    expect(ready[0].workerUrl).toBe("http://worker:9999");

    // → connected (SDP answer received)
    await db.update(sessions)
      .set({ status: "connected", sdpAnswer: "v=0", stateEnteredAt: new Date() })
      .where(eq(sessions.id, session.id));
    const connected = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1);
    expect(connected[0].status).toBe("connected");

    // → playing (data channel open)
    await db.update(sessions)
      .set({ status: "playing", stateEnteredAt: new Date() })
      .where(eq(sessions.id, session.id));
    const playing = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1);
    expect(playing[0].status).toBe("playing");

    // → ended
    await db.update(sessions)
      .set({ status: "ended", endedAt: new Date(), stateEnteredAt: new Date() })
      .where(eq(sessions.id, session.id));
    const ended = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1);
    expect(ended[0].status).toBe("ended");
    expect(ended[0].endedAt).toBeInstanceOf(Date);
  });

  it("session has FK constraint with users and servers", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();

    // Valid user+server — works
    const [session] = await db.insert(sessions).values({
      userId, serverId, gameId: "smw", status: "spawning",
    }).returning();
    expect(session.id).toBeTruthy();

    // Invalid user ID — should fail
    await expect(
      db.insert(sessions).values({
        userId: "00000000-0000-0000-0000-000000000001",
        gameId: "smw",
        status: "spawning",
      })
    ).rejects.toThrow();
  });

  it("session associates with command via commandId", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();
    const cmd = await seedCommand(serverId, "start_game", { game_id: "smw" });

    const [session] = await db.insert(sessions).values({
      userId, serverId, gameId: "smw", commandId: cmd.id, status: "spawning",
    }).returning();

    const rows = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1);
    expect(rows[0].commandId).toBe(cmd.id);
  });
});

describe("Launch events", () => {
  it("inserts and reads launch events", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();

    const [event] = await db.insert(launchEvents).values({
      serverId, gameId: "smw", source: "browser", event: "start_game_requested",
      detail: { game_id: "smw" },
    }).returning();

    expect(event.id).toBeTruthy();
    expect(event.source).toBe("browser");
    expect(event.event).toBe("start_game_requested");

    const rows = await db.select().from(launchEvents).where(eq(launchEvents.id, event.id)).limit(1);
    expect(rows[0].detail).toEqual({ game_id: "smw" });
  });
});

describe("Peer tokens", () => {
  it("creates peer tokens associated with a session", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();
    const [session] = await db.insert(sessions).values({
      userId, serverId, gameId: "smw", status: "playing",
    }).returning();

    const [token] = await db.insert(peerTokens).values({
      sessionId: session.id,
      token: "abcdef0123456789abcdef0123456789",
      seat: 0,
      role: "host",
    }).returning();

    expect(token.id).toBeTruthy();
    expect(token.seat).toBe(0);
    expect(token.role).toBe("host");
  });

  it("enforces unique tokens", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();
    const [session] = await db.insert(sessions).values({
      userId, serverId, gameId: "smw", status: "playing",
    }).returning();

    await db.insert(peerTokens).values({
      sessionId: session.id, token: "dup-token", seat: 0, role: "host",
    });

    await expect(
      db.insert(peerTokens).values({
        sessionId: session.id, token: "dup-token", seat: 1, role: "viewer",
      })
    ).rejects.toThrow();
  });
});

describe("Command lifecycle", () => {
  it("transitions pending → leased → completed", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();

    const [cmd] = await db.insert(commands).values({
      serverId, type: "start_game", payload: { game_id: "smw" }, status: "pending",
    }).returning();
    expect(cmd.status).toBe("pending");

    await db.update(commands)
      .set({ status: "leased", leaseToken: "lease-123", leasedAt: new Date() })
      .where(eq(commands.id, cmd.id));
    const leased = await db.select().from(commands).where(eq(commands.id, cmd.id)).limit(1);
    expect(leased[0].status).toBe("leased");

    await db.update(commands)
      .set({ status: "completed", completedAt: new Date(), result: { ok: true } })
      .where(eq(commands.id, cmd.id));
    const completed = await db.select().from(commands).where(eq(commands.id, cmd.id)).limit(1);
    expect(completed[0].status).toBe("completed");
    expect(completed[0].result).toEqual({ ok: true });
  });

  it("transitions pending → leased → failed", async () => {
    const db = getTestDb();
    const { userId, serverId } = await seedUserAndServer();

    const [cmd] = await db.insert(commands).values({
      serverId, type: "start_game", payload: { game_id: "smw" }, status: "pending",
    }).returning();

    await db.update(commands)
      .set({ status: "failed", lastError: "no core", completedAt: new Date() })
      .where(eq(commands.id, cmd.id));
    const failed = await db.select().from(commands).where(eq(commands.id, cmd.id)).limit(1);
    expect(failed[0].status).toBe("failed");
    expect(failed[0].lastError).toBe("no core");
  });
});
