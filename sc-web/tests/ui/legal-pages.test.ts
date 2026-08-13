import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const landing = readFileSync("components/LandingPage.tsx", "utf8");
const help = readFileSync("components/HelpPage.tsx", "utf8");
const footer = readFileSync("components/LegalFooter.tsx", "utf8");
const privacy = readFileSync("app/privacy/page.tsx", "utf8");
const cookies = readFileSync("app/cookies/page.tsx", "utf8");
const terms = readFileSync("app/terms/page.tsx", "utf8");
const legalPage = readFileSync("components/LegalPage.tsx", "utf8");

describe("public legal disclosures", () => {
  it("links policies and privacy choices from public footers", () => {
    for (const source of [landing, help]) {
      expect(source).toContain("<LegalFooter />");
    }
    expect(footer).toContain('href="/privacy"');
    expect(footer).toContain('href="/cookies"');
    expect(footer).toContain('href="/terms"');
    expect(footer).toContain("Privacy choices");
    expect(footer).toContain("Joel Longanecker and Sprite Cloud contributors");
  });

  it("renders the shared route-aware navigation on every legal page", () => {
    expect(legalPage).toContain('import AppHeader from "@/components/fluent/AppHeader";');
    expect(legalPage).toContain("<AppHeader");
    expect(legalPage).toContain("authenticated={Boolean(session?.user?.id)}");
  });

  it("accurately distinguishes necessary storage, diagnostics, and optional analytics", () => {
    expect(privacy).toContain("email address");
    expect(privacy).toContain("first-party operational diagnostics");
    expect(privacy).toContain("PostHog");
    expect(privacy).toContain("WebRTC");
    expect(privacy).toContain("self-hosted gateway");
    expect(cookies).toContain("sc_csrf_token");
    expect(cookies).toContain("authjs.session-token");
    expect(cookies).toContain("sc_host_");
    expect(cookies).toContain("localStorage");
    expect(cookies).toContain("Necessary only");
  });

  it("states content responsibility and the AGPL/source terms", () => {
    expect(terms).toContain("ROMs, BIOS files, artwork");
    expect(terms).toContain("GNU Affero General Public License");
    expect(terms).toContain("corresponding source code");
    expect(terms).toContain("as is");
  });
});
