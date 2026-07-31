import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { randomBytes } from "crypto";
import path from "path";
import { db } from "@/lib/db";
import { commands } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const DOWNLOAD_EXPIRY_MS = 5 * 60 * 1000;
const UPLOAD_DIR = path.join(process.cwd(), ".downloads");

const downloads = new Map<string, { filePath: string; name: string; size: number; expiresAt: number }>();
export { downloads };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ server_id: string; game_id: string }> },
) {
  const { server_id, game_id } = await params;

  // Auth: validate lease_token + command_id match
  const commandId = request.headers.get("x-command-id");
  const leaseToken = request.headers.get("x-lease-token");

  if (!commandId || !leaseToken) {
    return NextResponse.json({ error: "missing auth headers" }, { status: 403 });
  }

  const [cmd] = await db
    .select({ id: commands.id, serverId: commands.serverId, type: commands.type, leaseToken: commands.leaseToken })
    .from(commands)
    .where(eq(commands.id, commandId));

  if (!cmd || cmd.serverId !== server_id || cmd.type !== "rom_download" || cmd.leaseToken !== leaseToken) {
    return NextResponse.json({ error: "invalid command" }, { status: 403 });
  }

  const uploadId = randomBytes(16).toString("hex");
  const buffer = Buffer.from(await request.arrayBuffer());
  const name = request.headers.get("x-game-name") || game_id;

  await mkdir(UPLOAD_DIR, { recursive: true });
  const filePath = path.join(UPLOAD_DIR, uploadId);
  await writeFile(filePath, buffer);

  downloads.set(uploadId, {
    filePath,
    name,
    size: buffer.length,
    expiresAt: Date.now() + DOWNLOAD_EXPIRY_MS,
  });

  return NextResponse.json({ ok: true, upload_id: uploadId, size: buffer.length });
}
