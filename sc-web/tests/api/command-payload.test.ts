import { describe, expect, it } from "vitest";
import { commandSessionId, residentStopPayload } from "@/lib/command-payload";

describe("command payload compatibility", () => {
  it("writes production resident stop payloads as JSON objects", () => {
    const payload = residentStopPayload({
      gameId: "game-1",
      userId: "user-1",
      hostToken: "host-1",
      sessionId: "session-1",
    });

    expect(typeof payload).toBe("object");
    expect(payload).toEqual({
      game_id: "game-1",
      user_id: "user-1",
      authorized_user_id: "user-1",
      host_token: "host-1",
      session_id: "session-1",
    });
  });

  it("reads object and legacy string payloads without accepting malformed or nested values", () => {
    expect(commandSessionId({ session_id: "object-session" })).toBe("object-session");
    expect(commandSessionId(JSON.stringify({ session_id: "legacy-session" }))).toBe("legacy-session");
    expect(commandSessionId("{malformed")).toBeNull();
    expect(commandSessionId(JSON.stringify({ metadata: { session_id: "nested" } }))).toBeNull();
  });
});
