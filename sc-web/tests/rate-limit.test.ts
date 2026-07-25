import { describe, expect, it } from "vitest";
import { applyRateLimit } from "../lib/rate-limit";

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
});
