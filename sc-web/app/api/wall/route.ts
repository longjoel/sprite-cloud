import { NextResponse } from "next/server";
import { getWallGames } from "@/lib/wall";

// ── GET /api/wall ─────────────────────────────────────────────────────
//
// Public, unauthenticated — the Living Cabinet wall (#762): every game
// flagged `public` across ALL servers connected to the gateway, with server
// liveness and live-session state. Fail-closed: only `public` games appear,
// and nothing sensitive is exposed (no host tokens, no metadata, no user
// data). A live game's room token is exposed intentionally — a public game
// is a public room; the token is the capability that lets a guest watch or
// join it.
//
// Response:
// {
//   games: [{
//     id, name, platform, maxPlayers, coverUrl,
//     serverId, serverName, serverOnline,
//     live, players, viewers, maxSeats,
//     slug, watchUrl,          // stable shareable watch link
//     roomUrl?                 // present only when live
//   }]
// }

export async function GET() {
  const games = await getWallGames();
  return NextResponse.json({ games });
}
