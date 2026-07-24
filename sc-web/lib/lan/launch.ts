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

export interface LaunchHost {
  server_id: string;
  status: string;
  has_game: boolean;
}

export function canUseLanPlayer(
  probe: { reachable: boolean; reason?: string },
): boolean {
  return probe.reachable || probe.reason === "mixed_content_blocked";
}

/** Returns a host only when normal Play has an unambiguous healthy target. */
export function chooseLaunchHost<T extends LaunchHost>(hosts: readonly T[], preferredId: string | null): T | null {
  const playable = hosts.filter((host) => host.has_game && (host.status === "online" || host.status === "stale"));

  if (preferredId) {
    return playable.find((host) => host.server_id === preferredId) ?? null;
  }

  return playable.length === 1 ? playable[0] : null;
}

export interface LaunchRequestGate {
  beginRequest(): number;
  isCurrent(generation: number): boolean;
  invalidate(): void;
  tryBeginLaunch(): boolean;
  finishLaunch(): void;
}

export function createLaunchRequestGate(): LaunchRequestGate {
  let generation = 0;
  let launching = false;
  return {
    beginRequest() {
      generation += 1;
      return generation;
    },
    isCurrent(candidate) {
      return candidate === generation;
    },
    invalidate() {
      generation += 1;
    },
    tryBeginLaunch() {
      if (launching) return false;
      launching = true;
      return true;
    },
    finishLaunch() {
      launching = false;
    },
  };
}

export function formatLaunchError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  return message || fallback;
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
