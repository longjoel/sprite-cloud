import { describe, expect, it } from "vitest";
import { buildLanPlayerLaunchUrl } from "@/lib/lan/launch";

describe("buildLanPlayerLaunchUrl", () => {
  it("builds a LAN player URL with host token as query param for proxy forwarding", () => {
    const url = buildLanPlayerLaunchUrl({
      playerUrls: ["http://192.168.86.128:8787/"],
      gameId: "pokemon-yellow",
      serverId: "server-bazzite",
      code: "ABC123",
      hostToken: "host-secret",
    });

    expect(url).toBe(
      "http://192.168.86.128:8787/pokemon-yellow?code=ABC123&server_id=server-bazzite&route=lan&host_token=host-secret",
    );
    const parsed = new URL(url!);
    expect(parsed.searchParams.get("host_token")).toBe("host-secret");
    expect(parsed.hash).toBe("");
  });

  it("encodes game ids in the path", () => {
    const url = buildLanPlayerLaunchUrl({
      playerUrls: ["http://192.168.86.128:8787/"],
      gameId: "Game Boy/Pokémon Yellow.gb",
      serverId: "server-vault",
      code: "XYZ789",
      hostToken: "host-secret",
    });

    expect(url).toBe(
      "http://192.168.86.128:8787/Game%20Boy%2FPok%C3%A9mon%20Yellow.gb?code=XYZ789&server_id=server-vault&route=lan&host_token=host-secret",
    );
  });

  it("ignores invalid or missing launch inputs", () => {
    expect(buildLanPlayerLaunchUrl({ playerUrls: [], gameId: "smw", serverId: "s1", code: "ABC123", hostToken: "h" })).toBeNull();
    expect(buildLanPlayerLaunchUrl({ playerUrls: ["file:///tmp/player"], gameId: "smw", serverId: "s1", code: "ABC123", hostToken: "h" })).toBeNull();
    expect(buildLanPlayerLaunchUrl({ playerUrls: ["http://192.168.1.5:8787"], gameId: "smw", serverId: "s1", code: "", hostToken: "h" })).toBeNull();
  });
});
