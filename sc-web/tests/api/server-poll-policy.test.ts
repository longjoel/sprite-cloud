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
import { SESSION_STATE_TIMEOUT_MS, SDP_ANSWER_WAIT_MS } from "@/lib/constants";

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
    // Lifecycle lease must exceed the worst-case sc-server SDP/ICE execution
    // (two attempts × 30s ICE-gathering timeout ≈ 65s) so a still-running
    // serial command is never re-leased — that re-lease-while-running was the
    // original retry-amplification bug (a command reached 3,392 attempts).
    expect(commandLeaseMs("start_game")).toBe(120_000);
    expect(commandLeaseMs("sdp_offer")).toBe(120_000);
    expect(commandLeaseMs("stop_game")).toBe(120_000);
    expect(SESSION_STATE_TIMEOUT_MS).toBeGreaterThan(
      MAX_COMMAND_ATTEMPTS * commandLeaseMs("start_game"),
    );
  });

  it("keeps the lifecycle lease inside the client SDP-answer wait window", () => {
    // If sc-server crashes after leasing, the command is only redeliverable
    // after lease expiry, and a redelivered execution can take up to the full
    // SDP/ICE ceiling. The browser-side answer wait must therefore span lease
    // + one redelivered execution, otherwise the launch times out before the
    // lease-retry mechanism can help (review follow-up on #831).
    expect(SDP_ANSWER_WAIT_MS).toBeGreaterThan(
      commandLeaseMs("start_game") + 65_000,
    );
    expect(SDP_ANSWER_WAIT_MS).toBe(240_000);
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
