// ── Shared polling utilities ─────────────────────────────────────────

import { useEffect, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────

export interface PollUntilOptions {
  /** Interval between poll attempts in ms (default: 1000). */
  intervalMs?: number;
  /** Maximum number of poll attempts before giving up. */
  maxAttempts?: number;
  /** Maximum time to poll in ms before giving up. */
  timeoutMs?: number;
  /** Optional AbortSignal to cancel polling. */
  signal?: AbortSignal;
}

// ── React hooks ────────────────────────────────────────────────────────

/**
 * Run a callback on a fixed interval.  Pauses when `intervalMs` is null.
 * Uses a ref to always call the latest callback without restarting the timer.
 *
 * @example
 * useInterval(() => { doPoll(); }, 5000);
 */
export function useInterval(
  callback: () => void,
  intervalMs: number | null,
): void {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (intervalMs === null) return;

    const id = setInterval(() => savedCallback.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

// ── Async polling ──────────────────────────────────────────────────────

/**
 * Repeatedly call an async function until it returns a non-null value,
 * the attempt/timeout limit is hit, or the signal is aborted.
 *
 * The function should return the desired value when ready, or `null` /
 * `undefined` to signal "not ready yet".  Thrown errors propagate immediately.
 *
 * @example
 * const workerUrl = await pollUntil(
 *   async () => {
 *     const r = await fetch("/api/server/notify?...");
 *     const data = await r.json();
 *     return data.worker_url ?? null;
 *   },
 *   { intervalMs: 500, timeoutMs: 30_000 },
 * );
 */
export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  options: PollUntilOptions = {},
): Promise<T> {
  const {
    intervalMs = 1000,
    maxAttempts,
    timeoutMs,
    signal,
  } = options;

  if (maxAttempts === undefined && timeoutMs === undefined) {
    throw new Error("pollUntil requires maxAttempts or timeoutMs");
  }

  const start = Date.now();
  let attempt = 0;

  while (true) {
    if (signal?.aborted) throw new DOMException("Polling aborted", "AbortError");

    if (maxAttempts !== undefined && attempt >= maxAttempts) {
      throw new Error(
        `Polling timed out after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}`,
      );
    }

    if (timeoutMs !== undefined && Date.now() - start >= timeoutMs) {
      throw new Error(
        `Polling timed out after ${timeoutMs}ms`,
      );
    }

    const result = await fn();
    if (result !== null && result !== undefined) {
      return result;
    }

    attempt++;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
