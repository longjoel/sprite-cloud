// ── Shared constants (no magic values) ────────────────────────────────

/** Poll interval when commands were just delivered (fast follow-up). */
export const POLL_FAST_MS = 250;

/** Poll interval when idle (no pending commands). */
export const POLL_IDLE_MS = 2000;

/** How long to stay in fast-poll mode after delivering commands. */
export const POLL_FAST_DURATION_MS = 5000;

/** Recognised command types. */
export const CMD_START_GAME = "start_game" as const;
export const CMD_STOP_GAME = "stop_game" as const;
export const CMD_SDP_OFFER = "sdp_offer" as const;

export type CommandType =
  | typeof CMD_START_GAME
  | typeof CMD_STOP_GAME
  | typeof CMD_SDP_OFFER;

/** Command statuses in the queue. */
export const STATUS_PENDING = "pending" as const;
export const STATUS_DELIVERED = "delivered" as const;
