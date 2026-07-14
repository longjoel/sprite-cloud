// Shared launch lifecycle utilities.
// Used by XMB, classic library, and any future launcher to create short
// codes and build player URLs in one canonical place.

export interface CreateLaunchShortCodeParams {
  gameId: string;
  serverId: string;
  hostToken?: string;
  signal?: AbortSignal;
}

/**
 * Call POST /api/room/shorten to create a short code for the given game.
 * Returns the short code string.
 * Throws if the API fails or returns no code.
 */
export async function createLaunchShortCode(
  params: CreateLaunchShortCodeParams,
): Promise<string> {
  const { gameId, serverId, hostToken = crypto.randomUUID(), signal } = params;

  const resp = await fetch("/api/room/shorten", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      game_id: gameId,
      host_token: hostToken,
      server_id: serverId,
    }),
    signal,
  });

  if (!resp.ok) {
    throw new Error("Could not create a play link");
  }

  const data = (await resp.json()) as { code?: unknown };
  if (typeof data.code !== "string" || !data.code.trim()) {
    throw new Error("The play link response did not include a code");
  }

  return data.code;
}

/**
 * Build the canonical player path for a given short code.
 * Optionally append a shell parameter (e.g. "xmb") so the player page
 * knows which shell to return to on close / back.
 */
export function buildPlayerPath(code: string, shell?: string): string {
  if (shell) {
    return `/p/${code}?shell=${encodeURIComponent(shell)}`;
  }
  return `/p/${code}`;
}
