import { describe, expect, it } from "vitest";
import { isLanPlayerLocation } from "@/lib/lan/player-origin";

function locationLike(href: string) {
  const url = new URL(href);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    search: url.search,
  };
}

describe("LAN player origin classification", () => {
  it("recognizes canonical private sc-server player URLs without a query marker", () => {
    expect(isLanPlayerLocation(locationLike("http://192.168.86.128:8787/p/ABC123"))).toBe(true);
    expect(isLanPlayerLocation(locationLike("http://10.0.0.8:8787/p/ABC123"))).toBe(true);
    expect(isLanPlayerLocation(locationLike("http://vault.local:8787/p/ABC123"))).toBe(true);
  });

  it("preserves the explicit route marker", () => {
    expect(isLanPlayerLocation(locationLike("https://sprite-cloud.com/p/ABC123?route=lan"))).toBe(true);
  });

  it("does not classify public, secure, or wrong-port origins as LAN-direct", () => {
    expect(isLanPlayerLocation(locationLike("http://203.0.113.8:8787/p/ABC123"))).toBe(false);
    expect(isLanPlayerLocation(locationLike("https://192.168.86.128:8787/p/ABC123"))).toBe(false);
    expect(isLanPlayerLocation(locationLike("http://192.168.86.128:3000/p/ABC123"))).toBe(false);
  });
});
