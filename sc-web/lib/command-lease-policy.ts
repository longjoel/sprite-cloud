import { COMMAND_LEASE_MS } from "@/lib/constants";

export const POLL_BATCH_SIZE = 1;
export const POLL_SCAN_SIZE = 25;
export const MAX_COMMAND_ATTEMPTS = 3;

const DEFAULT_LEASE_MS = COMMAND_LEASE_MS;

/**
 * Lifecycle lease for WebRTC command execution.
 *
 * Must exceed the worst-case sc-server SDP/ICE execution so a still-running
 * serial command is never re-leased (that re-lease-while-running was the
 * original retry-amplification bug: a command reached 3,392 attempts). The
 * ceiling is the SDP exchange: up to two attempts, each bounded by the 30s
 * ICE-gathering timeout in `sc-server/src/webrtc.rs`, plus build/swap
 * overhead (~65s total). 120s is a comfortable margin above that ceiling.
 *
 * It must also stay *shorter* than the client-side SDP-answer wait windows
 * (SDP_ANSWER_WAIT_MS in constants.ts and the wall/relay poll deadline), so
 * that if sc-server crashes after leasing, lease expiry + redelivery can
 * still complete within the client's patience instead of the launch timing
 * out before the retry mechanism benefits it.
 */
const LIFECYCLE_LEASE_MS = 120_000;
const TRANSFER_LEASE_MS = 15 * 60_000;

export function commandLeaseMs(commandType: string): number {
  if (["start_game", "sdp_offer"].includes(commandType)) return LIFECYCLE_LEASE_MS;
  if (commandType === "stop_game") return LIFECYCLE_LEASE_MS;
  if (["rom_transfer", "rom_download", "stage_rom", "upgrade_server"].includes(commandType)) {
    return TRANSFER_LEASE_MS;
  }
  return DEFAULT_LEASE_MS;
}

export function isCommandAttemptExhausted(attempts: number): boolean {
  return attempts >= MAX_COMMAND_ATTEMPTS;
}
