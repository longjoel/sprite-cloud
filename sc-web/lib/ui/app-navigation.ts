export interface AppNavigationItem {
  label: string;
  href: string;
}

interface AppNavigationOptions {
  authenticated: boolean;
  isLanProxy?: boolean;
}

export const APP_NAVIGATION = {
  home: { label: "Home", href: "/" },
  library: { label: "Library", href: "/library" },
  dashboard: { label: "Dashboard", href: "/servers" },
  help: { label: "Help", href: "/help" },
  signIn: { label: "Sign in", href: "/signin?callbackUrl=/library" },
  signOut: { label: "Sign out", href: "/api/auth/signout" },
} as const satisfies Record<string, AppNavigationItem>;

export function buildAppNavigationItems({ authenticated, isLanProxy = false }: AppNavigationOptions): AppNavigationItem[] {
  const { home, library, dashboard, help, signIn, signOut } = APP_NAVIGATION;
  if (isLanProxy) return [{ ...library, href: "/" }, help];
  if (authenticated) return [home, library, dashboard, help, signOut];
  return [home, help, signIn];
}

export function isAppNavigationItemActive(href: string, pathname: string): boolean {
  if (href.startsWith("/api/") || href.startsWith("/signin")) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
