/**
 * Double-tap gesture recognizer for the mobile player's preclude of
 * entering immersive/fullscreen mode.
 *
 * Pure and DOM-independent so it is unit-testable in a node environment. The
 * React shell feeds raw pointer-up coordinates plus a flag for whether the
 * pointer landed on an interactive control (button/link/`[data-touch-target]`).
 *
 * Contract:
 * - Two pointer-ups within `maxIntervalMs` and within `maxSlopPx` of each other
 *   fire `onDoubleTap`.
 * - A tap that lands on an interactive control never counts toward a double-tap
 *   and clears any pending first tap, so a gesture spanning on-screen controls
 *   (which never itself triggers fullscreen) cannot fire.
 * - A quick triple-tap fires exactly once (the recognizer resets on fire).
 * - `handlePointerUp` only records non-interactive samples; `reset()` forces a
 *   fresh start (e.g. on entering/exiting fullscreen or on escape).
 */

export interface PointerUpSample {
  readonly x: number;
  readonly y: number;
  readonly interactive: boolean;
}

export interface DoubleTapDetectorOptions {
  /** Max ms between the two taps. Default 300. */
  maxIntervalMs?: number;
  /** Max euclidean distance (px) between the two taps. Default 60. */
  maxSlopPx?: number;
  /** Injectable clock for deterministic tests. Default Date.now. */
  now?: () => number;
  /** Invoked when a valid double-tap is recognized. */
  onDoubleTap: () => void;
}

const DEFAULT_INTERVAL_MS = 300;
const DEFAULT_SLOP_PX = 60;

interface PendingTap {
  x: number;
  y: number;
  t: number;
}

export class DoubleTapDetector {
  private readonly maxIntervalMs: number;
  private readonly maxSlopPx: number;
  private readonly now: () => number;
  private readonly onDoubleTap: () => void;
  private pending: PendingTap | null = null;

  constructor(opts: DoubleTapDetectorOptions) {
    this.maxIntervalMs = opts.maxIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxSlopPx = opts.maxSlopPx ?? DEFAULT_SLOP_PX;
    this.now = opts.now ?? (() => Date.now());
    this.onDoubleTap = opts.onDoubleTap;
  }

  handlePointerUp(sample: PointerUpSample): void {
    // Interactive controls never form a double-tap and cancel any pending tap.
    if (sample.interactive) {
      this.pending = null;
      return;
    }

    const t = this.now();
    if (this.pending && t - this.pending.t <= this.maxIntervalMs) {
      const dx = sample.x - this.pending.x;
      const dy = sample.y - this.pending.y;
      if (dx * dx + dy * dy <= this.maxSlopPx * this.maxSlopPx) {
        this.pending = null;
        this.onDoubleTap();
        return;
      }
    }

    this.pending = { x: sample.x, y: sample.y, t };
  }

  reset(): void {
    this.pending = null;
  }
}