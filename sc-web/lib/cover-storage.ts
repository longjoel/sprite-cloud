import sharp from "sharp";
import { mkdir, open, readFile, rename, rm } from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { join } from "path";

export const MAX_COVER_BYTES = 10 * 1024 * 1024;
export const MAX_COVER_DIMENSION = 4096;
export const MAX_COVER_PIXELS = 16_000_000;
export const MAX_GIF_PAGES = 240;
export const MAX_ANIMATED_PIXELS = 64_000_000;
const ROOT = () => process.env.GV_COVER_OVERRIDES_DIR;

export interface NormalizedCover {
  bytes: Buffer;
  poster: Buffer;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  extension: "png" | "jpg" | "webp" | "gif";
  width: number;
  height: number;
  animated: boolean;
  frameCount: number;
}

export function coverStorageCapability() {
  return { configured: !!ROOT(), maxBytes: MAX_COVER_BYTES };
}

export async function readBoundedBody(body: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  if (!body) throw new Error("image body is required");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_COVER_BYTES) {
        await reader.cancel();
        throw new Error("cover exceeds 10 MB");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function normalizeCover(input: Buffer): Promise<NormalizedCover> {
  if (!input.length || input.length > MAX_COVER_BYTES) throw new Error("cover exceeds 10 MB");
  const probe = sharp(input, { animated: true, limitInputPixels: MAX_COVER_PIXELS, failOn: "warning" });
  const metadata = await probe.metadata();
  const width = metadata.width ?? 0;
  const pageHeight = metadata.pageHeight ?? metadata.height ?? 0;
  const pages = metadata.pages ?? 1;
  if (!width || !pageHeight || width > MAX_COVER_DIMENSION || pageHeight > MAX_COVER_DIMENSION || width * pageHeight > MAX_COVER_PIXELS) {
    throw new Error("cover dimensions exceed 4096×4096");
  }
  if (pages > MAX_GIF_PAGES) throw new Error(`animated cover exceeds ${MAX_GIF_PAGES} frames`);
  if (width * pageHeight * pages > MAX_ANIMATED_PIXELS) throw new Error("animated cover is too complex");
  const format = metadata.format;
  if (!format || !["png", "jpeg", "webp", "gif"].includes(format)) throw new Error("unsupported image format");
  const animated = format === "gif" && pages > 1;
  const poster = await sharp(input, { page: 0, limitInputPixels: MAX_COVER_PIXELS, failOn: "warning" })
    .rotate().resize({ width: 900, height: 1200, fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  if (animated) {
    const bytes = await sharp(input, { animated: true, limitInputPixels: MAX_COVER_PIXELS, failOn: "warning" })
      .resize({ width: 900, height: 1200, fit: "inside", withoutEnlargement: true })
      .gif({ effort: 7 }).toBuffer();
    return { bytes, poster, mediaType: "image/gif", extension: "gif", width, height: pageHeight, animated, frameCount: pages };
  }
  const bytes = await sharp(input, { limitInputPixels: MAX_COVER_PIXELS, failOn: "warning" })
    .rotate().resize({ width: 900, height: 1200, fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
  return { bytes, poster, mediaType: "image/webp", extension: "webp", width, height: pageHeight, animated: false, frameCount: 1 };
}

async function atomicWrite(path: string, bytes: Buffer) {
  const temporary = `${path}.${randomUUID()}.partial`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function persistCover(cover: NormalizedCover): Promise<{ assetId: string; posterAssetId: string }> {
  const root = ROOT();
  if (!root) throw new Error("cover storage is not configured");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const assetKey = createHash("sha256").update(randomUUID()).update(cover.bytes).digest("hex");
  const assetId = `${assetKey}.${cover.extension}`;
  const posterAssetId = `${assetKey}.poster.png`;
  const assetPath = join(root, assetId);
  const posterPath = join(root, posterAssetId);
  try {
    await atomicWrite(assetPath, cover.bytes);
    await atomicWrite(posterPath, cover.poster);
  } catch (error) {
    await Promise.all([
      rm(assetPath, { force: true }).catch(() => undefined),
      rm(posterPath, { force: true }).catch(() => undefined),
    ]);
    throw error;
  }
  return { assetId, posterAssetId };
}

export async function readCoverAsset(assetId: string): Promise<Buffer | null> {
  const root = ROOT();
  if (!root || !/^[a-f0-9]{64}\.(?:png|webp|jpg|gif|poster\.png)$/.test(assetId)) return null;
  try { return await readFile(join(root, assetId)); } catch { return null; }
}

export async function removeCoverAssets(assetIds: Array<string | null | undefined>) {
  const root = ROOT();
  if (!root) return;
  await Promise.all([...new Set(assetIds.filter((id): id is string => !!id))].map(async (id) => {
    if (/^[a-f0-9]{64}\.(?:png|webp|jpg|gif|poster\.png)$/.test(id)) await rm(join(root, id), { force: true });
  }));
}
