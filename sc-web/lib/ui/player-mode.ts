/**
 * Player-mode helpers for the mobile immersive model.
 *
 * Product rule (Epic #846 resolution):
 *   - The normal page (Room view) must not show on-screen game controls —
 *     they would obstruct navigation.
 *   - The virtual gamepad is visible ONLY while immersive/fullscreen.
 *   - A player may still turn controls off even while immersive.
 */

export interface PlayerMode {
  /** Whether the player is currently in immersive/fullscreen mode. */
  immersive: boolean;
  /** Whether the user has enabled on-screen controls (their toggle). */
  userEnabledControls: boolean;
}

/** Effective on-screen-control visibility under the immersive model. */
export function resolveControlsEnabled(
  immersive: boolean,
  userEnabledControls: boolean,
): boolean {
  if (!immersive) return false;
  return userEnabledControls;
}