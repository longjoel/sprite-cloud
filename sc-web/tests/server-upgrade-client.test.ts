import { describe, expect, it, vi } from "vitest";
import { runServerUpgrade, type ServerUpdateState } from "@/lib/server-upgrade-client";

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("runServerUpgrade", () => {
  it("reports success only after a durable completed result that confirms restart", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(202, { command_id: "upgrade-1" }))
      .mockResolvedValueOnce(response(200, { status: "leased" }))
      .mockResolvedValueOnce(response(200, { status: "completed", result: { ok: true, restarting: true } }));
    const states: ServerUpdateState[] = [];

    await runServerUpgrade("server-1", {}, (state) => states.push(state), fetcher, async () => {});

    expect(states).toEqual(["queued", "running", "done"]);
  });

  it("fails closed when completion does not confirm activation", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(202, { command_id: "upgrade-1" }))
      .mockResolvedValueOnce(response(200, { status: "completed", result: { ok: true } }));
    const updates: Array<[ServerUpdateState, string]> = [];

    await runServerUpgrade("server-1", {}, (state, message) => updates.push([state, message]), fetcher, async () => {});

    expect(updates.at(-1)).toEqual(["failed", "update failed"]);
  });

  it("shows the server's sanitized failure result", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(202, { command_id: "upgrade-1" }))
      .mockResolvedValueOnce(response(200, { status: "completed", result: { ok: false, error: "game session active" } }));
    const updates: Array<[ServerUpdateState, string]> = [];

    await runServerUpgrade("server-1", {}, (state, message) => updates.push([state, message]), fetcher, async () => {});

    expect(updates.at(-1)).toEqual(["failed", "game session active"]);
  });

  it("resumes an existing update without submitting a duplicate command", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { status: "leased" }))
      .mockResolvedValueOnce(response(200, { status: "completed", result: { ok: true, restarting: true } }));
    const states: ServerUpdateState[] = [];

    await runServerUpgrade(
      "server-1",
      {},
      (state) => states.push(state),
      fetcher,
      async () => {},
      "upgrade-existing",
    );

    expect(fetcher).not.toHaveBeenCalledWith(
      "/api/servers/server-1/upgrade",
      expect.anything(),
    );
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/commands/upgrade-existing/result");
    expect(states).toEqual(["running", "running", "done"]);
  });

  it("joins the winning command when another tab queued the update first", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(409, { error: "an update is already queued", command_id: "upgrade-winner" }))
      .mockResolvedValueOnce(response(200, { status: "completed", result: { ok: true, restarting: true } }));
    const states: ServerUpdateState[] = [];

    await runServerUpgrade("server-1", {}, (state) => states.push(state), fetcher, async () => {});

    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/commands/upgrade-winner/result");
    expect(states).toEqual(["queued", "done"]);
  });
});
