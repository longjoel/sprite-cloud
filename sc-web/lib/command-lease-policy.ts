import { COMMAND_LEASE_MS } from "@/lib/constants";

export const POLL_BATCH_SIZE = 1;
export const POLL_SCAN_SIZE = 25;
export const MAX_COMMAND_ATTEMPTS = 3;

const DEFAULT_LEASE_MS = COMMAND_LEASE_MS;
const TRANSFER_LEASE_MS = 15 * 60_000;

export function commandLeaseMs(commandType: string): number {
  if (["start_game", "sdp_offer"].includes(commandType)) return 240_000;
  if (commandType === "stop_game") return 120_000;
  if (["rom_transfer", "rom_download", "stage_rom", "upgrade_server"].includes(commandType)) {
    return TRANSFER_LEASE_MS;
  }
  return DEFAULT_LEASE_MS;
}

export function isCommandAttemptExhausted(attempts: number): boolean {
  return attempts >= MAX_COMMAND_ATTEMPTS;
}
