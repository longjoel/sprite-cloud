export type XmbCategoryId = "games" | "settings";
export type XmbNavigationId = XmbCategoryId | "classic";

export type XmbNavigationItem =
  | { id: XmbCategoryId; kind: "category" }
  | { id: "classic"; kind: "action"; href: "/" };

export interface XmbNavigationState {
  focusedId: XmbNavigationId;
  activeCategory: XmbCategoryId;
}

export function getXmbNavigation(settingsAvailable: boolean): XmbNavigationItem[] {
  return settingsAvailable
    ? [
        { id: "games", kind: "category" },
        { id: "settings", kind: "category" },
        { id: "classic", kind: "action", href: "/" },
      ]
    : [
        { id: "games", kind: "category" },
        { id: "classic", kind: "action", href: "/" },
      ];
}

export function reconcileXmbNavigation(
  state: XmbNavigationState,
  settingsAvailable: boolean,
): XmbNavigationState {
  if (!settingsAvailable && (state.focusedId === "settings" || state.activeCategory === "settings")) {
    return { focusedId: "games", activeCategory: "games" };
  }
  return state;
}

export function moveXmbNavigation(
  state: XmbNavigationState,
  settingsAvailable: boolean,
  delta: -1 | 1,
): XmbNavigationState {
  const reconciled = reconcileXmbNavigation(state, settingsAvailable);
  const items = getXmbNavigation(settingsAvailable);
  const currentIndex = Math.max(0, items.findIndex((item) => item.id === reconciled.focusedId));
  const next = items[Math.max(0, Math.min(items.length - 1, currentIndex + delta))];
  return {
    focusedId: next.id,
    activeCategory: next.kind === "category" ? next.id : reconciled.activeCategory,
  };
}

export function activateXmbNavigation(
  state: XmbNavigationState,
  settingsAvailable: boolean,
  navigate: (href: string) => void,
): XmbNavigationState {
  const reconciled = reconcileXmbNavigation(state, settingsAvailable);
  const item = getXmbNavigation(settingsAvailable).find(({ id }) => id === reconciled.focusedId);
  if (item?.kind === "action") navigate(item.href);
  return item?.kind === "category"
    ? { focusedId: item.id, activeCategory: item.id }
    : reconciled;
}

export function getXmbSettingsActions(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-xmb-settings-action]:not([disabled])"));
}

export function focusXmbSettingsAction(root: ParentNode, index: number): number | null {
  const actions = getXmbSettingsActions(root);
  if (actions.length === 0) return null;
  const safeIndex = Math.max(0, Math.min(actions.length - 1, index));
  actions[safeIndex].focus();
  return safeIndex;
}

export function activateXmbSettingsAction(root: ParentNode, index: number): boolean {
  const safeIndex = focusXmbSettingsAction(root, index);
  if (safeIndex === null) return false;
  getXmbSettingsActions(root)[safeIndex]?.click();
  return true;
}
