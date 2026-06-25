// ── Long-poll: hold start_game POST open until gv-server returns SDP answer ────
//
// When a host launches a game with an SDP offer in the start_game payload,
// we hold the POST request open until the gv-server processes the command
// and sends the SDP answer back via the notify endpoint.
//
// This eliminates the browser-side polling loop — the answer comes directly
// in the POST response.

const SDP_TIMEOUT_MS = 30_000; // how long to wait for the answer

interface PendingEntry {
  resolve: (sdpAnswer: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

/** Register a waiting request. Returns a Promise that resolves with the SDP answer. */
export function waitForSdpAnswer(commandId: string): Promise<string> {
  // Reject any existing waiter for this command (shouldn't happen)
  const existing = pending.get(commandId);
  if (existing) {
    existing.reject(new Error("superseded"));
    clearTimeout(existing.timer);
  }

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(commandId);
      reject(new Error("Timed out waiting for SDP answer from server"));
    }, SDP_TIMEOUT_MS);

    pending.set(commandId, { resolve, reject, timer });
  });
}

/** Called by the notify handler when an SDP answer arrives. */
export function resolveSdpAnswer(commandId: string, sdpAnswer: string): boolean {
  const entry = pending.get(commandId);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pending.delete(commandId);
  entry.resolve(sdpAnswer);
  return true;
}

/** Clean up on timeout / error — reject without the answer. */
export function rejectSdpAnswer(commandId: string, reason: string): boolean {
  const entry = pending.get(commandId);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pending.delete(commandId);
  entry.reject(new Error(reason));
  return true;
}
