// ── Library client utilities ──────────────────────────────────────────

import { randomUuid } from "@/lib/browser/random-uuid";

export function csrfHeaders(): Record<string, string> {
  if (typeof document === "undefined") {
    return { "Content-Type": "application/json" };
  }
  let token = document.cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("sc_csrf_token="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!token) {
    token = randomUuid();
    document.cookie = `sc_csrf_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  }
  return { "Content-Type": "application/json", "x-csrf-token": decodeURIComponent(token) };
}
