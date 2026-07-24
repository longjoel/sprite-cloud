import { describe, expect, it } from "vitest";
import { extractLanLibraryLinks } from "@/lib/lan/library-handoff";

describe("LAN library handoff", () => {
  it("prefers a physical LAN interface over container bridges", () => {
    const links = extractLanLibraryLinks([
      {
        serverId: "server-vault",
        name: "VAULT",
        metadata: {
          interfaces: [
            { name: "docker0", address: "172.17.0.1" },
            { name: "enp5s0", address: "192.0.2.126" },
          ],
          lan: {
            player_urls: [
              "http://172.17.0.1:8787/",
              "http://192.0.2.126:8787/",
            ],
          },
        },
      },
    ]);

    expect(links).toEqual([
      {
        serverId: "server-vault",
        name: "VAULT",
        url: "http://192.0.2.126:8787/",
      },
    ]);
  });

  it("rejects unsafe URLs and deduplicates servers", () => {
    const links = extractLanLibraryLinks([
      {
        serverId: "server-vault",
        name: "VAULT",
        metadata: {
          lan: {
            player_urls: [
              "javascript:alert(1)",
              "http://192.0.2.126:8787/",
              "http://192.0.2.126:8787/",
            ],
          },
        },
      },
    ]);

    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe("http://192.0.2.126:8787/");
  });
});
