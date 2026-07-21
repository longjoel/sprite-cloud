// ── Library client utilities ──────────────────────────────────────────

export function getPreferredServer(gameId: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`sc_host_${gameId}=`));
  if (!match) return null;
  return decodeURIComponent(match.split("=").slice(1).join("="));
}

export function setPreferredServer(gameId: string, serverId: string) {
  if (typeof document === "undefined") return;
  document.cookie = `sc_host_${gameId}=${encodeURIComponent(serverId)}; Path=/; Max-Age=${365 * 24 * 3600}; SameSite=Lax`;
}

export function statusVariant(status: string) {
  const map: Record<string, "success" | "warning" | "error"> = {
    online: "success",
    stale: "warning",
    offline: "error",
  };
  return map[status] || "error";
}

export function hostRouteVariant(route: string) {
  const map: Record<string, "success" | "info" | "warning" | "muted"> = {
    local: "success",
    direct: "info",
    relay: "warning",
    unknown: "muted",
  };
  return map[route] || "muted";
}

export function csrfHeaders(): Record<string, string> {
  let token = document.cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("sc_csrf_token="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!token) {
    token = crypto.randomUUID();
    document.cookie = `sc_csrf_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  }
  return { "Content-Type": "application/json", "x-csrf-token": decodeURIComponent(token) };
}
