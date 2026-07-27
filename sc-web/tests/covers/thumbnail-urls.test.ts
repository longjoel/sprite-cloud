import { describe, it, expect } from "vitest";
import { getThumbnailUrls, getBoxartUrl } from "@/lib/covers/thumbnail-urls";

describe("getThumbnailUrls", () => {
  it("builds correct NES box art URL", () => {
    const urls = getThumbnailUrls("Super Mario Bros.", "NES");
    expect(urls.boxart).toContain(
      "Nintendo%20-%20Nintendo%20Entertainment%20System",
    );
    expect(urls.boxart).toContain("Named_Boxarts");
    expect(urls.boxart).toContain("Super%20Mario%20Bros");
    expect(urls.boxart).toMatch(/\.png$/);
  });

  it("builds correct SNES URL with special chars", () => {
    const urls = getThumbnailUrls(
      "Super Mario World 2: Yoshi's Island",
      "SNES",
    );
    expect(urls.boxart).toContain("Named_Boxarts");
    expect(urls.boxart).toContain("Nintendo%20-%20Super%20Nintendo");
  });

  it("builds all three image type URLs for Genesis", () => {
    const urls = getThumbnailUrls("Sonic the Hedgehog", "Genesis");
    expect(urls.boxart).toContain("Named_Boxarts");
    expect(urls.boxart).toContain("Sega%20-%20Mega%20Drive%20-%20Genesis");
    expect(urls.screenshot).toContain("Named_Snaps");
    expect(urls.title).toContain("Named_Titles");
  });

  it("handles ampersands in game names", () => {
    const urls = getThumbnailUrls("Sonic & Knuckles", "Genesis");
    expect(urls.boxart).toContain("Sonic%20_%20Knuckles");
  });

  it("handles forward slashes in game names", () => {
    const urls = getThumbnailUrls("Alex Kidd in Miracle/Shinobi World", "Master System");
    expect(urls.boxart).not.toContain("Miracle/Shinobi");
    // / should be replaced by _
    expect(urls.boxart).toMatch(/Miracle_Shinobi|Miracle%20World/);
  });

  it("returns null for unknown platform", () => {
    const urls = getThumbnailUrls("Some Game", "TotallyFakePlatform");
    expect(urls.boxart).toBeNull();
    expect(urls.screenshot).toBeNull();
    expect(urls.title).toBeNull();
  });

  it("handles empty platform string", () => {
    const urls = getThumbnailUrls("Game", "");
    expect(urls.boxart).toBeNull();
  });
});

describe("getBoxartUrl", () => {
  it("returns boxart URL for known platform", () => {
    const url = getBoxartUrl("Metroid", "NES");
    expect(url).toContain("Named_Boxarts");
    expect(url).toContain(".png");
  });

  it("returns null for unknown platform", () => {
    expect(getBoxartUrl("Game", "Unknown")).toBeNull();
  });
});
