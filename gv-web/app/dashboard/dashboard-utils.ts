// ── Shared dashboard utilities (CSRF, time helpers, type guards) ──────

import { pollUntil } from "@/lib/poll";

// ── Type Guards ────────────────────────────────────────────────────────

export const NUMERIC_UUID_RE = /^[0-9a-f-]{36}$/;

// ── Time Helpers ───────────────────────────────────────────────────────

export function serverStatus(
  lastSeenAt: string | null,
): { label: string; color: string } {
  if (!lastSeenAt) return { label: "offline", color: "var(--color-error)" };
  const age = Date.now() - new Date(lastSeenAt).getTime();
  if (age < 1_800_000)
    return { label: "online", color: "var(--color-success)" };
  if (age < 86_400_000)
    return { label: "idle", color: "var(--color-muted)" };
  return { label: "offline", color: "var(--color-error)" };
}

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
      .find((p) => p.startsWith("gv_csrf_token="))
      ?.split("=")
      .slice(1)
      .join("=");
    if (!token) {
      token = crypto.randomUUID();
      document.cookie = `gv_csrf_token=${encodeURIComponent(
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

// ── Server Command Helpers ────────────────────────────────────────────

export async function enqueueCommand(
  serverId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const resp = await fetch("/api/server/command", {
    method: "POST",
    headers: csrfHeaders(),
    body: JSON.stringify({ server_id: serverId, type, payload }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function pollResult(
  commandId: string,
  maxTries = 30,
): Promise<Record<string, unknown> | null> {
  return pollUntil(
    async () => {
      const resp = await fetch(`/api/commands/${commandId}/result`);
      if (resp.status === 404) return null;
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      return data.result !== null && data.result !== undefined
        ? (data.result as Record<string, unknown>)
        : null;
    },
    { intervalMs: 1000, maxAttempts: maxTries },
  );
}
