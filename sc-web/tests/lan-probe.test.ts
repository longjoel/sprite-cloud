import { describe, expect, it, vi } from "vitest";
import { probeLanHealth } from "@/lib/lan/probe";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("probeLanHealth", () => {
  it("returns the first reachable LAN health endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: "ok",
        service: "sc-server-player",
        lan_player: true,
        version: "0.3.3",
        server_id: "server-bazzite",
        user_id: "user-joel",
        server_name: "Bazzite",
      }),
    ) as unknown as typeof fetch;

    const result = await probeLanHealth(["http://192.168.86.128:8787/health"], {
      fetchImpl,
      pageProtocol: "http:",
      now: (() => {
        let t = 10;
        return () => (t += 7);
      })(),
    });

    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.url).toBe("http://192.168.86.128:8787/health");
      expect(result.serverId).toBe("server-bazzite");
      expect(result.serverName).toBe("Bazzite");
      expect(result.latencyMs).toBeGreaterThan(0);
    }
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.168.86.128:8787/health",
      expect.objectContaining({ method: "GET", mode: "cors", cache: "no-store" }),
    );
  });

  it("classifies HTTPS page to HTTP LAN probe as mixed-content blocked without fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const result = await probeLanHealth(["http://192.168.86.128:8787/health"], {
      fetchImpl,
      pageProtocol: "https:",
    });

    expect(result).toMatchObject({
      reachable: false,
      reason: "mixed_content_blocked",
      url: "http://192.168.86.128:8787/health",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies invalid health JSON as invalid_response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ status: "ok", lan_player: false }),
    ) as unknown as typeof fetch;

    const result = await probeLanHealth(["http://192.168.86.128:8787/health"], {
      fetchImpl,
      pageProtocol: "http:",
    });

    expect(result).toMatchObject({
      reachable: false,
      reason: "invalid_response",
    });
  });

  it("classifies aborted probes as timeout", async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const result = await probeLanHealth(["http://192.168.86.128:8787/health"], {
      fetchImpl,
      pageProtocol: "http:",
      timeoutMs: 1,
    });

    expect(result).toMatchObject({
      reachable: false,
      reason: "timeout",
      url: "http://192.168.86.128:8787/health",
    });
  });

  it("returns no_urls when metadata has no LAN health URLs", async () => {
    const result = await probeLanHealth([], { pageProtocol: "http:" });
    expect(result).toEqual({ reachable: false, reason: "no_urls" });
  });
});
