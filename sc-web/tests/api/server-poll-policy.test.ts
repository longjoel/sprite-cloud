import { describe, expect, it } from "vitest";
import {
  MAX_COMMAND_ATTEMPTS,
  POLL_BATCH_SIZE,
  POLL_SCAN_SIZE,
  commandLeaseMs,
  isCommandAttemptExhausted,
} from "@/lib/command-lease-policy";
import fs from "node:fs";
import path from "node:path";
import { SESSION_STATE_TIMEOUT_MS } from "@/lib/constants";

const pollRoute = fs.readFileSync(
  path.join(process.cwd(), "app/api/server/poll/route.ts"),
  "utf8",
);

describe("server command lease policy", () => {
  it("leases one command because sc-server executes commands serially", () => {
    expect(POLL_BATCH_SIZE).toBe(1);
    expect(POLL_SCAN_SIZE).toBeGreaterThan(POLL_BATCH_SIZE);
    expect(pollRoute).toContain(".limit(POLL_SCAN_SIZE)");
    expect(pollRoute).toContain(".slice(0, POLL_BATCH_SIZE)");
  });

  it("gives WebRTC lifecycle commands enough time to finish before re-leasing", () => {
    expect(commandLeaseMs("start_game")).toBe(240_000);
    expect(commandLeaseMs("sdp_offer")).toBe(240_000);
    expect(commandLeaseMs("stop_game")).toBe(120_000);
    expect(SESSION_STATE_TIMEOUT_MS).toBeGreaterThan(
      MAX_COMMAND_ATTEMPTS * commandLeaseMs("start_game"),
    );
  });

  it("prioritizes teardown and drains poisoned rows without an idle poll", () => {
    expect(pollRoute.indexOf("when 'stop_game' then 0")).toBeGreaterThan(-1);
    expect(pollRoute).toContain("const exhaustedIds = rows");
    expect(pollRoute).toContain("const leaseable = rows");
    expect(pollRoute.indexOf("const exhaustedIds = rows")).toBeLessThan(
      pollRoute.indexOf("const leaseable = rows"),
    );
  });

  it("bounds retries instead of leasing a failed command forever", () => {
    expect(MAX_COMMAND_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(isCommandAttemptExhausted(MAX_COMMAND_ATTEMPTS - 1)).toBe(false);
    expect(isCommandAttemptExhausted(MAX_COMMAND_ATTEMPTS)).toBe(true);
    expect(pollRoute).toContain("MAX_COMMAND_ATTEMPTS");
    expect(pollRoute).toContain('status: "failed"');
  });

  it("terminalizes stale targets and writes resident stops as JSON objects", () => {
    expect(pollRoute).toContain("target session is no longer active");
    expect(pollRoute).not.toContain("payload: JSON.stringify({");
  });
});
