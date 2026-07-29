// ── Shared polling utilities ─────────────────────────────────────────

import { useEffect, useRef } from "react";

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
