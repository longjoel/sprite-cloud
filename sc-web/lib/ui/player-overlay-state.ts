export type PlayerPanel = "options" | "saves" | "keys" | "stats" | "share" | "room" | "controller";

export type PlayerOverlayState =
  | { activePanel: "none" }
  | { activePanel: PlayerPanel };

export const INITIAL_PLAYER_OVERLAY_STATE: PlayerOverlayState = { activePanel: "none" };

export function openPlayerPanel(
  _state: PlayerOverlayState,
  panel: PlayerPanel,
): PlayerOverlayState {
  return { activePanel: panel };
}

export function closePlayerPanel(_state: PlayerOverlayState): PlayerOverlayState {
  return { activePanel: "none" };
}

const CHILD_PANELS: ReadonlySet<PlayerPanel> = new Set([
  "saves", "stats", "keys", "room", "share", "controller",
]);

export function backPlayerPanel(state: PlayerOverlayState): PlayerOverlayState {
  if (state.activePanel !== "none" && CHILD_PANELS.has(state.activePanel)) {
    return { activePanel: "options" };
  }
  return { activePanel: "none" };
}

export function blockPlayerPanels(_state: PlayerOverlayState): PlayerOverlayState {
  return { activePanel: "none" };
}

export interface TouchGamepadVisibilityApi {
  hide: () => void;
  show: () => void;
  suspendInput?: () => void;
  resumeInput?: () => void;
}

export function releaseVisibleTouchGamepad(
  touchGamepad: TouchGamepadVisibilityApi | undefined,
  visible: boolean,
): void {
  if (!touchGamepad || !visible) return;
  if (touchGamepad.suspendInput) {
    touchGamepad.suspendInput();
    return;
  }
  touchGamepad.hide();
  touchGamepad.show();
}
