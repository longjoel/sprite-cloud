import { NextRequest, NextResponse } from "next/server";
import { readFile, unlink } from "fs/promises";

// Re-use the registry from the upload endpoint
import { downloads } from "../../servers/[server_id]/rom-downloads/[game_id]/upload/route";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ upload_id: string }> },
) {
  const { upload_id } = await params;

  const entry = downloads.get(upload_id);
  if (!entry) {
    return NextResponse.json({ error: "download not found or expired" }, { status: 404 });
  }

  if (Date.now() > entry.expiresAt) {
    try { await unlink(entry.filePath); } catch {}
    downloads.delete(upload_id);
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(entry.filePath);
  } catch {
    downloads.delete(upload_id);
    return NextResponse.json({ error: "file not found" }, { status: 404 });
  }

  // Delete after single use
  try { await unlink(entry.filePath); } catch {}
  downloads.delete(upload_id);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(entry.name)}"`,
      "Content-Length": String(entry.size),
      "Cache-Control": "no-store",
    },
  });
}
