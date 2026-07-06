export type SignalingFlow =
  | "host_start"
  | "host_reconnect"
  | "guest_join"
  | "guest_offer"
  | "notify"
  | "stop";

function normalizeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value.length === 0 ? '""' : JSON.stringify(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(normalizeValue).join(",")}]`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function logSignalingStage(
  flow: SignalingFlow,
  stage: string,
  fields: Record<string, unknown> = {},
): void {
  const ordered = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  const suffix = ordered.length
    ? " " + ordered.map(([key, value]) => `${key}=${normalizeValue(value)}`).join(" ")
    : "";
  console.info(`[SIGNAL] flow=${flow} stage=${stage}${suffix}`);
}

export function classifyCommandFlow(
  type: string,
  payload: Record<string, unknown>,
): SignalingFlow | null {
  if (type === "start_game") {
    return "host_start";
  }
  if (type === "sdp_offer") {
    return payload.peer_token || payload.room_token ? "guest_offer" : "host_reconnect";
  }
  if (type === "stop_game") {
    return "stop";
  }
  return null;
}
