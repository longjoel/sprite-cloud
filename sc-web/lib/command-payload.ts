export function commandPayloadObject(payload: unknown): Record<string, unknown> | null {
  try {
    const value = typeof payload === "string" ? JSON.parse(payload) : payload;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function commandSessionId(payload: unknown): string | null {
  const sessionId = commandPayloadObject(payload)?.session_id;
  return typeof sessionId === "string" ? sessionId : null;
}

export function residentStopPayload(input: {
  gameId: string;
  userId: string;
  hostToken: string | null;
  sessionId: string;
}): Record<string, unknown> {
  return {
    game_id: input.gameId,
    user_id: input.userId,
    authorized_user_id: input.userId,
    host_token: input.hostToken,
    session_id: input.sessionId,
  };
}
