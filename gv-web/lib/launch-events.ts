import { db } from "@/lib/db";
import { launchEvents } from "@/lib/db/schema";

export interface LaunchEventInput {
  sessionId?: string | null;
  commandId?: string | null;
  serverId?: string | null;
  gameId?: string | null;
  source: "browser" | "gv-web" | "gv-server" | "host-runtime";
  event: string;
  detail?: Record<string, unknown>;
}

/**
 * Best-effort launch timeline recording.
 *
 * Telemetry must never break gameplay launch, and `detail` must never contain
 * credentials, bearer tokens, worker tokens, host tokens, SDP blobs, or raw
 * request bodies.
 */
export async function recordLaunchEvent(input: LaunchEventInput): Promise<void> {
  try {
    await db.insert(launchEvents).values({
      sessionId: input.sessionId ?? null,
      commandId: input.commandId ?? null,
      serverId: input.serverId ?? null,
      gameId: input.gameId ?? null,
      source: input.source,
      event: input.event,
      detail: input.detail ?? {},
    });
  } catch (error) {
    console.warn("[launch-events] failed to record event", {
      event: input.event,
      source: input.source,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
