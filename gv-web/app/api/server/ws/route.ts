// Placeholder — WebSocket endpoint for gv-server (coming soon).
// For now, gv-server uses HTTP polling via /api/server/poll.
// This file reserves the route for future WebSocket upgrade support.

export async function GET() {
  return new Response("WebSocket upgrade not yet supported — use /api/server/poll", { status: 426 });
}
