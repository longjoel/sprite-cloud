import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRateLimit } from "../lib/rate-limit";

afterEach(() => {
  vi.useRealTimers();
});

describe("API rate-limit isolation", () => {
  it("does not let notify polling exhaust the command bucket for the same client IP", () => {
    const headers = { "x-forwarded-for": "198.51.100.77" };
    const pollRequest = new Request("https://sprite-cloud.com/api/server/notify/poll", {
      method: "POST",
      headers,
    });
    const commandRequest = new Request("https://sprite-cloud.com/api/server/command", {
      method: "POST",
      headers,
    });

    for (let i = 0; i < 30; i += 1) {
      expect(applyRateLimit(pollRequest, 180)).toBeNull();
    }

    expect(applyRateLimit(commandRequest, 30)).toBeNull();
  });

  it("retains long-window attempts across the one-minute cleanup tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00Z"));
    vi.resetModules();
    const { checkRateLimit } = await import("../lib/rate-limit");
    const key = "invite-redemption:198.51.100.99";
    const windowMs = 15 * 60_000;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(checkRateLimit(key, 10, windowMs).allowed).toBe(true);
    }
    expect(checkRateLimit(key, 10, windowMs)).toMatchObject({ allowed: false, retryAfter: 900 });

    await vi.advanceTimersByTimeAsync(61_000);
    expect(checkRateLimit(key, 10, windowMs)).toMatchObject({ allowed: false, retryAfter: 839 });

    await vi.advanceTimersByTimeAsync(839_001);
    expect(checkRateLimit(key, 10, windowMs).allowed).toBe(true);
  });
});
