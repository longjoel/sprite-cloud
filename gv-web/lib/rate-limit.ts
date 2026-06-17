/**
 * In-memory rate limiter for API routes.
 *
 * Uses a sliding-window approach: timestamps older than the window
 * are pruned on every check.  State lives in a module-level Map so
 * it resets on process restart (acceptable for the threat model).
 *
 * Limits are per-IP by default; routes that use bearer-auth can pass
 * the server id as the key override.
 */

// ── Store ──────────────────────────────────────────────────────────────

interface WindowEntry {
  timestamps: number[];
}

const store = new Map<string, WindowEntry>();

// Periodic cleanup every 60s to prevent unbounded memory growth
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter((ts) => now - ts < 60_000);
      if (entry.timestamps.length === 0) store.delete(key);
    }
  }, 60_000).unref?.();
}

// ── Public API ─────────────────────────────────────────────────────────

export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Suggested Retry-After value in seconds (when not allowed). */
  retryAfter: number;
  /** Number of requests remaining in the current window. */
  remaining: number;
  /** Unix timestamp (ms) when the window resets. */
  reset: number;
}

/**
 * Check whether `key` has exceeded `maxRequests` within the last
 * `windowMs` milliseconds.
 *
 * @param key       Identifier (typically the client IP).
 * @param maxRequests  Maximum allowed requests in the window.
 * @param windowMs     Sliding-window duration in ms (default 60_000).
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs = 60_000,
): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  // Prune expired timestamps
  entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);

  const count = entry.timestamps.length;
  const allowed = count < maxRequests;

  if (allowed) {
    entry.timestamps.push(now);
  }

  const oldest = entry.timestamps.length > 0 ? entry.timestamps[0] : now;
  const reset = oldest + windowMs;
  const retryAfter = Math.max(1, Math.ceil((reset - now) / 1000));

  return {
    allowed,
    retryAfter,
    remaining: Math.max(0, maxRequests - count - (allowed ? 1 : 0)),
    reset,
  };
}

/**
 * Extract the client IP from a Request.
 * Respects x-forwarded-for / x-real-ip headers commonly set by reverse proxies.
 * Returns a safe fallback when request is null/undefined (test environments).
 */
export function getClientIP(request?: Request | null): string {
  if (!request?.headers) return "127.0.0.1";

  // x-forwarded-for is a comma-separated list; the leftmost is the original client
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();

  // Fallback — in local dev this is often ::1 or 127.0.0.1
  return "127.0.0.1";
}

/**
 * Convenience wrapper: applies rate limiting and returns a 429 response
 * when the limit is exceeded.  Otherwise returns null (continue processing).
 *
 * Adds X-RateLimit-* headers to the response whether allowed or denied.
 */
export function applyRateLimit(
  request: Request,
  maxRequests: number,
  windowMs = 60_000,
  key?: string,
): Response | null {
  const effectiveKey = key ?? getClientIP(request);
  const result = checkRateLimit(effectiveKey, maxRequests, windowMs);

  const headers = new Headers({
    "X-RateLimit-Limit": String(maxRequests),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.reset / 1000)),
  });

  if (!result.allowed) {
    headers.set("Retry-After", String(result.retryAfter));
    return new Response(
      JSON.stringify({ error: "too many requests — rate limit exceeded" }),
      { status: 429, headers },
    );
  }

  return null; // allowed — caller adds headers to their own response
}

/**
 * Return X-RateLimit-* headers for the caller to attach to their response
 * after a successful rate-limit check.
 */
export function rateLimitHeaders(request: Request, maxRequests: number, windowMs = 60_000, key?: string): Headers {
  const effectiveKey = key ?? getClientIP(request);
  // We already consumed the request in the main handler — re-compute for headers.
  // This is safe because the key was already counted; we just need the remaining count.
  const entry = store.get(effectiveKey);
  const count = entry?.timestamps.length ?? 0;
  const remaining = Math.max(0, maxRequests - count);

  const oldest = (entry?.timestamps?.[0]) ?? Date.now();
  const reset = oldest + windowMs;

  return new Headers({
    "X-RateLimit-Limit": String(maxRequests),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(Math.ceil(reset / 1000)),
  });
}
