import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("LAN-owned library access", () => {
  it("renders Classic without cloud auth when sc-server marks the proxied request", () => {
    const source = readFileSync("app/page.tsx", "utf8");
    expect(source).toContain('requestHeaders.get("x-sc-server-lan")');
    expect(source).toContain("verifyBearerToken");
    expect(source).toContain('requestHeaders.get("authorization")');
    expect(source).toContain("<LibraryClient");
  });

  it("keeps unauthenticated XMB on LAN after a successful local health probe", () => {
    const source = readFileSync("app/xmb/page.tsx", "utf8");
    expect(source).toContain('fetch("/health"');
    expect(source).toContain('health?.service === "sc-server-player"');
  });

  it("marks only sc-server-originated proxy requests as LAN requests", () => {
    const source = readFileSync("../sc-server/src/player_server.rs", "utf8");
    expect(source).toContain('header("x-sc-server-lan", "1")');
    expect(source).toContain("proxy_server_authenticated");
    expect(source).toContain("server_api_key");
    expect(source).toContain("axum::http::header::AUTHORIZATION");
    expect(source).toContain('req.uri().path() == "/"');
  });
});
