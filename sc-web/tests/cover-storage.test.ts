import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_COVER_BYTES, normalizeCover, persistCover, readBoundedBody } from "@/lib/cover-storage";

let storageDir: string;

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "sprite-cover-test-"));
  process.env.GV_COVER_OVERRIDES_DIR = storageDir;
});
afterEach(async () => {
  delete process.env.GV_COVER_OVERRIDES_DIR;
  await rm(storageDir, { recursive: true, force: true });
});

describe("cover storage hardening", () => {
  it("decodes by content, strips static metadata, bounds dimensions, and writes private random assets", async () => {
    const input = await sharp({ create: { width: 16, height: 12, channels: 4, background: "#ff00ff" } })
      .png().withMetadata({ orientation: 1 }).toBuffer();
    const normalized = await normalizeCover(input);
    expect(normalized.mediaType).toBe("image/webp");
    expect(normalized.width).toBe(16);
    expect(normalized.height).toBe(12);
    const assets = await persistCover(normalized);
    expect(assets.assetId).toMatch(/^[a-f0-9]{64}\.webp$/);
    expect(assets.posterAssetId).toMatch(/^[a-f0-9]{64}\.poster\.png$/);
    expect((await stat(join(storageDir, assets.assetId))).mode & 0o077).toBe(0);
    expect((await readFile(join(storageDir, assets.assetId))).length).toBeGreaterThan(0);
  });

  it("rejects SVG and decompression-bomb dimensions from actual bytes", async () => {
    await expect(normalizeCover(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).rejects.toThrow();
    const huge = await sharp({ create: { width: 4097, height: 1, channels: 3, background: "red" } }).png().toBuffer();
    await expect(normalizeCover(huge)).rejects.toThrow("dimensions");
  });

  it("re-encodes animated GIFs while preserving animation and dropping trailing data", async () => {
    const frame = Buffer.from("R0lGODlhAwACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAwACAAAIBgABCBwYEAAh+QQBCgABACwAAAAAAwACAIEAAP8AAAAAAAAAAAAIBgABCBwYEAA7", "base64");
    const input = Buffer.concat([frame, Buffer.from("untrusted-trailer")]);
    const normalized = await normalizeCover(input);
    expect(normalized.mediaType).toBe("image/gif");
    expect(normalized.animated).toBe(true);
    expect(normalized.frameCount).toBe(2);
    expect(normalized.bytes.equals(input)).toBe(false);
    expect(normalized.bytes.includes(Buffer.from("untrusted-trailer"))).toBe(false);
  });

  it("cancels streaming requests as soon as the byte cap is crossed", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(MAX_COVER_BYTES + 1)); },
      cancel() { cancelled = true; },
    });
    await expect(readBoundedBody(body)).rejects.toThrow("10 MB");
    expect(cancelled).toBe(true);
  });
});
