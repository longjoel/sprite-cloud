import { redirect } from "next/navigation";

// ── GAME_ID → Proxy redirect ──────────────────────────────────────────────
// All three views (admin, guest, LAN) now load the player from the worker
// via the worker-proxy API route. This page just resolves params and redirects.

interface Props {
  params: Promise<{ game_id: string }>;
  searchParams: Promise<{ server_id?: string; join?: string }>;
}

export default async function PlayPage(props: Props) {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const { game_id } = params;
  const { server_id, join } = searchParams;

  const proxyPath = `/api/worker-proxy/${encodeURIComponent(game_id)}/`;

  const query = new URLSearchParams();
  if (join) query.set("room_token", join);
  if (server_id) query.set("server_id", server_id);

  const qs = query.toString();
  const target = qs ? `${proxyPath}?${qs}` : proxyPath;

  redirect(target);
}
