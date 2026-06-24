import { NextRequest, NextResponse } from "next/server";

// ── No-path → player redirect ───────────────────────────────────────────
// Catch-all [[...path]] needs at least one segment.
// Redirect to /player so the worker's relative asset URLs resolve correctly.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ game_id: string }> },
) {
  const { game_id } = await params;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "localhost";
  const proto = request.headers.get("x-forwarded-proto") || "https";
  const qs = request.nextUrl.searchParams.toString();
  const base = `${proto}://${host}/api/worker-proxy/${encodeURIComponent(game_id)}/player/`;
  return NextResponse.redirect(qs ? `${base}?${qs}` : base, 307);
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
