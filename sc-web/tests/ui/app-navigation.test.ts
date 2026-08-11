import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAppNavigationItems,
  isAppNavigationItemActive,
} from "@/lib/ui/app-navigation";

const landingCss = readFileSync("components/LandingPage.module.css", "utf8");
const landingSource = readFileSync("components/LandingPage.tsx", "utf8");
const helpSource = readFileSync("components/HelpPage.tsx", "utf8");
const librarySource = readFileSync("components/LibraryClient.tsx", "utf8");
const dashboardSource = readFileSync("app/servers/page.tsx", "utf8");
const playerOptionsSource = readFileSync("components/OptionsOverlay.tsx", "utf8");

describe("shared app navigation", () => {
  it("builds one consistent authenticated navigation model", () => {
    expect(buildAppNavigationItems({ authenticated: true })).toEqual([
      { label: "Home", href: "/" },
      { label: "Library", href: "/library" },
      { label: "Dashboard", href: "/servers" },
      { label: "Help", href: "/help" },
      { label: "Sign out", href: "/api/auth/signout" },
    ]);
  });

  it("keeps anonymous and LAN-proxy authentication actions fail closed", () => {
    expect(buildAppNavigationItems({ authenticated: false })).toEqual([
      { label: "Home", href: "/" },
      { label: "Help", href: "/help" },
      { label: "Sign in", href: "/signin?callbackUrl=/library" },
    ]);
    for (const authenticated of [false, true]) {
      expect(buildAppNavigationItems({ authenticated, isLanProxy: true })).toEqual([
        { label: "Library", href: "/" },
        { label: "Help", href: "/help" },
      ]);
    }
  });

  it("marks the LAN root as Library instead of a cloud Home route", () => {
    const [library] = buildAppNavigationItems({ authenticated: false, isLanProxy: true });
    expect(library.label).toBe("Library");
    expect(isAppNavigationItemActive(library.href, "/")).toBe(true);
  });

  it("marks exact and nested application routes active without activating Home globally", () => {
    expect(isAppNavigationItemActive("/", "/")).toBe(true);
    expect(isAppNavigationItemActive("/library", "/library/game")).toBe(true);
    expect(isAppNavigationItemActive("/", "/library")).toBe(false);
    expect(isAppNavigationItemActive("/api/auth/signout", "/api/auth/signout")).toBe(false);
  });

  it("lets every ordinary page delegate link policy to AppHeader", () => {
    for (const source of [landingSource, helpSource, librarySource, dashboardSource]) {
      expect(source).not.toContain("links={");
    }
  });

  it("reuses the shared Library navigation identity in immersive player chrome", () => {
    expect(playerOptionsSource).toContain('from "@/lib/ui/app-navigation"');
    expect(playerOptionsSource).toContain("APP_NAVIGATION.library.label");
  });

  it("keeps the onboarding panel in normal document flow", () => {
    const onboardingRule = landingCss.match(/\.onboarding\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(onboardingRule).not.toMatch(/position:\s*sticky/);
    expect(onboardingRule).not.toMatch(/top:\s*84px/);
  });
});
