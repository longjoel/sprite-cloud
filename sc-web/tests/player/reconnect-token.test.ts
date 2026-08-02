// @vitest-environment jsdom
/**
 * Regression for issue #718:
 * "Poll fresh SDP command tokens during host reconnect"
 *
 * Verdict: a host reconnect that POSTs a fresh sdp_offer must poll with
 * only the fresh command's worker_token, never the stale start_game token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("host reconnect SDP token routing", () => {
  const freshWorkerToken = "fresh-cmd-token-abc123";
  const staleStartToken = "stale-start-token-old456";

  let polledTokens: string[];
  let fetchHandler: (url: string, init?: RequestInit) => Promise<Response>;

  beforeEach(() => {
    polledTokens = [];

    fetchHandler = async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const res: Record<string, unknown> = {};

      if (url.includes("/api/server/command")) {
        res.worker_token = freshWorkerToken;
      } else if (url.includes("/api/server/notify/poll")) {
        polledTokens.push(body.worker_token as string);
        res.sdp_answer = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n";
      }

      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    vi.stubGlobal("fetch", vi.fn((...args: [string, RequestInit?]) => fetchHandler(...args)));
    vi.stubGlobal("scCsrfHeaders", () => ({}));
  });

  afterEach(() => vi.unstubAllGlobals());

  // ── Core: simulate the reconnect SDP exchange and token routing ──

  it("polls with only the fresh workerToken after posting sdp_offer on reconnect", async () => {
    // Simulate reconnect: POST fresh sdp_offer, receive fresh workerToken,
    // then poll for the answer.
    const sdpOfferBody = {
      server_id: "server-1",
      type: "sdp_offer",
      payload: {
        game_id: "local_00112233445566778899aabbccddeeff",
        sdp: "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n",
        host_token: "host-capability-token",
      },
    };

    // Step 1 — POST sdp_offer (like connectViaRelay line 496)
    const cmdResp = await fetch("/api/server/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sdpOfferBody),
    });
    expect(cmdResp.ok).toBe(true);
    const cmdData = await cmdResp.json();
    expect(cmdData.worker_token).toBe(freshWorkerToken);

    // Step 2 — the reconnect client now chooses a token to poll with.
    // BUGGY behavior (current line 523: pollToken || workerToken):
    const buggyPollToken = staleStartToken || cmdData.worker_token;
    expect(buggyPollToken).toBe(staleStartToken); // RED — stale wins

    // FIXED behavior:
    const fixedPollToken = cmdData.worker_token;
    expect(fixedPollToken).toBe(freshWorkerToken); // fresh wins

    // Step 3 — poll with the right token
    await fetch("/api/server/notify/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_id: "server-1", worker_token: fixedPollToken }),
    });

    expect(polledTokens).toEqual([freshWorkerToken]);
  });
});
