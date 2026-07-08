export interface LanLaunchInput {
  playerUrls?: string[] | null;
  gameId: string;
  serverId: string;
  code: string;
  hostToken: string;
}

function normalizeBaseUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export function buildLanPlayerLaunchUrl(input: LanLaunchInput): string | null {
  const base = input.playerUrls?.find((url) => typeof url === "string" && url.trim().length > 0);
  if (!base || !input.gameId || !input.serverId || !input.code || !input.hostToken) return null;

  const url = normalizeBaseUrl(base);
  if (!url) return null;

  url.pathname = `/${encodeURIComponent(input.gameId)}`;
  url.search = "";
  url.searchParams.set("code", input.code);
  url.searchParams.set("server_id", input.serverId);
  url.searchParams.set("route", "lan");
  url.searchParams.set("host_token", input.hostToken);
  return url.toString();
}
