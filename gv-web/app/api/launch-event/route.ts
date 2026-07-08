import { NextRequest, NextResponse } from "next/server";
import { recordLaunchEvent } from "@/lib/launch-events";

// POST /api/launch-event — record browser-side launch telemetry.
// Low-privilege: uses the caller's auth session to infer userId but
// accepts arbitrary detail (capped at 2KB).  Never stores credentials.
export async function POST(request: NextRequest) {
  try {
    // Cap body size — diagnostics only, no large blobs
    const text = await request.text();
    if (text.length > 2048) {
      return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }

    const event = typeof body.event === "string" ? body.event : null;
    if (!event) {
      return NextResponse.json({ error: "event required" }, { status: 400 });
    }

    // Sanitize: never forward raw tokens/creds that might leak through
    const detail = body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
      ? body.detail as Record<string, unknown>
      : {};
    // Strip known sensitive keys
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detail)) {
      if (k.includes("token") || k.includes("secret") || k.includes("sdp") || k.includes("credential")) continue;
      if (typeof v === "string" && v.length > 256) continue; // long strings likely blobs
      safe[k] = v;
    }

    await recordLaunchEvent({
      gameId: typeof body.game_id === "string" ? body.game_id : null,
      serverId: typeof body.server_id === "string" ? body.server_id : null,
      source: "browser",
      event,
      detail: safe,
    });

    return NextResponse.json({ ok: true });
  } catch {
    // Best-effort — never break the page over telemetry
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
