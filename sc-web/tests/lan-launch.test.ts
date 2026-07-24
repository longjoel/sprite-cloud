import { describe, expect, it } from "vitest";
import { buildLanPlayerLaunchUrl, canUseLanPlayer, chooseLaunchHost, createLaunchRequestGate, formatLaunchError } from "@/lib/lan/launch";

describe("buildLanPlayerLaunchUrl", () => {
  it("permits LAN navigation when HTTPS blocks the health probe but direct nav still works", () => {
    expect(canUseLanPlayer({ reachable: false, reason: "mixed_content_blocked" })).toBe(true);
    expect(canUseLanPlayer({ reachable: false, reason: "timeout" })).toBe(false);
    expect(canUseLanPlayer({ reachable: true })).toBe(true);
  });
  it("builds a LAN player URL with host token as query param for proxy forwarding", () => {
    const url = buildLanPlayerLaunchUrl({
      playerUrls: ["http://192.0.2.1:8787/"],
      gameId: "pokemon-yellow",
      serverId: "server-bazzite",
      code: "ABC123",
      hostToken: "host-secret",
    });

    expect(url).toBe(
      "http://192.0.2.1:8787/pokemon-yellow?code=ABC123&server_id=server-bazzite&route=lan&host_token=host-secret",
    );
    const parsed = new URL(url!);
    expect(parsed.searchParams.get("host_token")).toBe("host-secret");
    expect(parsed.hash).toBe("");
  });

  it("encodes game ids in the path", () => {
    const url = buildLanPlayerLaunchUrl({
      playerUrls: ["http://192.0.2.1:8787/"],
      gameId: "Game Boy/Pokémon Yellow.gb",
      serverId: "server-vault",
      code: "XYZ789",
      hostToken: "host-secret",
    });

    expect(url).toBe(
      "http://192.0.2.1:8787/Game%20Boy%2FPok%C3%A9mon%20Yellow.gb?code=XYZ789&server_id=server-vault&route=lan&host_token=host-secret",
    );
  });

  it("ignores invalid or missing launch inputs", () => {
    expect(buildLanPlayerLaunchUrl({ playerUrls: [], gameId: "smw", serverId: "s1", code: "ABC123", hostToken: "h" })).toBeNull();
    expect(buildLanPlayerLaunchUrl({ playerUrls: ["file:///tmp/player"], gameId: "smw", serverId: "s1", code: "ABC123", hostToken: "h" })).toBeNull();
    expect(buildLanPlayerLaunchUrl({ playerUrls: ["http://192.168.1.5:8787"], gameId: "smw", serverId: "s1", code: "", hostToken: "h" })).toBeNull();
  });
});

const host = (server_id: string, status: string, has_game = true) => ({ server_id, status, has_game });

describe("chooseLaunchHost", () => {
  it("chooses the only playable online or stale host", () => {
    expect(chooseLaunchHost([
      host("offline", "offline"),
      host("missing", "online", false),
      host("available", "stale"),
    ], null)?.server_id).toBe("available");
  });

  it("chooses a healthy preferred host when several hosts are playable", () => {
    const hosts = [host("first", "online"), host("preferred", "stale")];
    expect(chooseLaunchHost(hosts, "preferred")?.server_id).toBe("preferred");
  });

  it("requires a picker when several hosts are playable without a preference", () => {
    expect(chooseLaunchHost([host("first", "online"), host("second", "stale")], null)).toBeNull();
  });

  it("requires a picker when the saved preference is unavailable", () => {
    expect(chooseLaunchHost([host("available", "online"), host("preferred", "offline")], "preferred")).toBeNull();
  });

  it("does not choose a host when none are playable", () => {
    expect(chooseLaunchHost([host("offline", "offline"), host("missing", "online", false)], null)).toBeNull();
  });
});

describe("createLaunchRequestGate", () => {
  it("invalidates stale host and probe requests when a newer picker session starts", () => {
    const gate = createLaunchRequestGate();
    const first = gate.beginRequest();
    const second = gate.beginRequest();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it("allows only one launch until it is explicitly finished", () => {
    const gate = createLaunchRequestGate();

    expect(gate.tryBeginLaunch()).toBe(true);
    expect(gate.tryBeginLaunch()).toBe(false);
    gate.finishLaunch();
    expect(gate.tryBeginLaunch()).toBe(true);
  });

  it("invalidates pending picker work when a session closes", () => {
    const gate = createLaunchRequestGate();
    const request = gate.beginRequest();
    gate.invalidate();
    expect(gate.isCurrent(request)).toBe(false);
  });
});

describe("formatLaunchError", () => {
  it("preserves concise known errors and safely falls back for unknown values", () => {
    expect(formatLaunchError(new Error("Host is no longer available"), "Launch failed")).toBe("Host is no longer available");
    expect(formatLaunchError({ message: "not trusted" }, "Launch failed")).toBe("Launch failed");
    expect(formatLaunchError(new Error("   "), "Launch failed")).toBe("Launch failed");
  });
});
