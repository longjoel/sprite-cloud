// ── Shared constants (no magic values) ────────────────────────────────

/** Poll interval when commands were just delivered (fast follow-up). */
export const POLL_FAST_MS = 250;

/** Poll interval when idle (no pending commands). */
export const POLL_IDLE_MS = 500;

/** Recognised command types. */
export const CMD_START_GAME = "start_game" as const;
export const CMD_STOP_GAME = "stop_game" as const;
export const CMD_SDP_OFFER = "sdp_offer" as const;
export const CMD_ROM_TRANSFER = "rom_transfer" as const;
export const CMD_DELETE_GAME = "delete_game" as const;

/** Command statuses in the queue. */
export const STATUS_PENDING = "pending" as const;
export const STATUS_LEASED = "leased" as const;
export const STATUS_COMPLETED = "completed" as const;

/** How long sc-server owns a leased command before it can be retried. */
export const COMMAND_LEASE_MS = 30_000;

/**
 * Client-side budget for a WebRTC command to produce an SDP answer.
 *
 * The lifecycle lease (command-lease-policy.ts) is 120s; a crash after
 * leasing leaves the command redeliverable only after lease expiry, and a
 * redelivered execution can take up to the full SDP/ICE ceiling (~65s). The
 * browser-side answer wait must therefore cover one lease plus one
 * redelivered execution so a launch waits for the retry mechanism instead of
 * timing out before it can help. 240s = 120s lease + ~65s execution + margin.
 */
export const SDP_ANSWER_WAIT_MS = 240_000;

/** Session states (state machine) */
export const SESSION_SPAWNING = "spawning" as const;
export const SESSION_READY = "ready" as const;
export const SESSION_CONNECTED = "connected" as const;
export const SESSION_PLAYING = "playing" as const;
export const SESSION_ENDED = "ended" as const;

/** Session states that are considered "active" (game in progress). */
export const ACTIVE_SESSION_STATES = new Set([
  SESSION_SPAWNING,
  SESSION_READY,
  SESSION_CONNECTED,
  SESSION_PLAYING,
]);

/** How long a session can stay in a single state before timing out. */
// Three 120s lifecycle leases (360s) plus a one-minute convergence margin.
// Cleanup must not terminalize a session while the final bounded attempt can
// run, so this stays comfortably above 3 × LIFECYCLE_LEASE_MS.
export const SESSION_STATE_TIMEOUT_MS = 13 * 60_000;
