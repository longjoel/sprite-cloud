export type PlayerPanel = "options" | "saves" | "keys" | "stats" | "share" | "controller";

export type PlayerOverlayState =
  | { activePanel: "none" }
  | { activePanel: PlayerPanel };

export function openPlayerPanel(
  _state: PlayerOverlayState,
  panel: PlayerPanel,
): PlayerOverlayState {
  return { activePanel: panel };
}

export function closePlayerPanel(_state: PlayerOverlayState): PlayerOverlayState {
  return { activePanel: "none" };
}
