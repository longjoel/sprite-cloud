// ── Shared dashboard utilities (CSRF, time helpers, type guards) ──────

import { randomUuid } from "@/lib/browser/random-uuid";

// ── Time Helpers ───────────────────────────────────────────────────────

export function timeAgo(ts: string | null): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ── CSRF Helpers ───────────────────────────────────────────────────────

let _csrfToken: string | undefined;

export function csrfHeaders(): Record<string, string> {
  if (!_csrfToken) {
    if (typeof document === "undefined") {
      // Server-side fallback — should never be called on server
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
      document.cookie = `sc_csrf_token=${encodeURIComponent(
        token,
      )}; Path=/; SameSite=Lax`;
    }
    _csrfToken = decodeURIComponent(token);
  }
  return {
    "Content-Type": "application/json",
    "x-csrf-token": _csrfToken,
  };
}
