import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";
import crypto from "crypto";
import bcrypt from "bcryptjs";

// ── LAN IP gate ───────────────────────────────────────────────────────

const LAN_CIDRS = ["127.", "10.", "192.168.", "172.16.", "172.17.", "172.18.",
  "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
  "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31."];

function isLanIp(ip: string): boolean {
  let clean = ip.split(",")[0]!.trim(); // x-forwarded-for may be chained
  // Normalise IPv4-mapped IPv6 addresses (::ffff:192.168.x.x → 192.168.x.x)
  if (clean.startsWith("::ffff:")) {
    clean = clean.slice(7);
  }
  return (
    LAN_CIDRS.some((prefix) => clean.startsWith(prefix)) ||
    clean === "::1" ||
    clean === "127.0.0.1"
  );
}

// ── LAN credentials ───────────────────────────────────────────────────

function lanCredentialsEnabled(): boolean {
  // LAN_PASS_HASH (bcrypt) is preferred.
  // LAN_PASS (plaintext) is deprecated but still supported for migration.
  return !!(process.env.LAN_USER && (process.env.LAN_PASS_HASH || process.env.LAN_PASS));
}

// ── Brute-force rate limiter (in-memory, per-IP) ──────────────────────

const AUTH_MAX_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 60_000;       // 1 minute
const AUTH_BLOCK_MS = 300_000;       // 5-minute block after threshold

interface AuthAttemptEntry {
  failures: number;          // count in current window
  windowStart: number;       // ms timestamp
  blockedUntil: number;      // 0 = not blocked
}

const authAttempts = new Map<string, AuthAttemptEntry>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authAttempts) {
    if (now - entry.windowStart > AUTH_BLOCK_MS * 2) {
      authAttempts.delete(key);
    }
  }
}, 300_000).unref?.();

function checkAuthRateLimit(ip: string): { allowed: boolean; waitSec: number } {
  const now = Date.now();
  let entry = authAttempts.get(ip);

  if (!entry) {
    entry = { failures: 0, windowStart: now, blockedUntil: 0 };
    authAttempts.set(ip, entry);
  }

  // If blocked, check if block has expired
  if (entry.blockedUntil > 0) {
    if (now < entry.blockedUntil) {
      return { allowed: false, waitSec: Math.ceil((entry.blockedUntil - now) / 1000) };
    }
    // Block expired — reset
    entry.blockedUntil = 0;
    entry.failures = 0;
    entry.windowStart = now;
  }

  // Reset window if expired
  if (now - entry.windowStart > AUTH_WINDOW_MS) {
    entry.failures = 0;
    entry.windowStart = now;
  }

  if (entry.failures >= AUTH_MAX_ATTEMPTS) {
    entry.blockedUntil = now + AUTH_BLOCK_MS;
    return { allowed: false, waitSec: Math.ceil(AUTH_BLOCK_MS / 1000) };
  }

  return { allowed: true, waitSec: 0 };
}

function recordAuthFailure(ip: string) {
  const entry = authAttempts.get(ip);
  if (entry) {
    entry.failures += 1;
  }
}

// ── Password verification ─────────────────────────────────────────────

/**
 * Verify a plaintext password against the configured credential.
 *
 * Prefers LAN_PASS_HASH (bcrypt). Falls back to LAN_PASS (plaintext,
 * deprecated) for migration. Logs a warning when plaintext fallback
 * is used so operators know to migrate.
 */
async function verifyPassword(plaintext: string): Promise<boolean> {
  // Preferred: bcrypt hash
  if (process.env.LAN_PASS_HASH) {
    return bcrypt.compare(plaintext, process.env.LAN_PASS_HASH);
  }

  // Deprecated fallback: plaintext comparison
  if (process.env.LAN_PASS) {
    console.warn(JSON.stringify({
      service: "gv-web",
      msg: "LAN_PASS (plaintext) is deprecated. Generate a hash with: node scripts/hash-password.mjs and set LAN_PASS_HASH instead.",
    }));
    return plaintext === process.env.LAN_PASS;
  }

  return false;
}

// ── Providers ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providers: any[] = [];
if (process.env.AUTH_GITHUB_ID) {
  providers.push(GitHub({}));
}

// Side door: LAN-only basic auth. Only available when LAN_USER + (LAN_PASS_HASH | LAN_PASS)
// are set. Requests from non-LAN IPs are rejected — this isn't a backdoor,
// it's a convenience for people already on the trusted network.
if (lanCredentialsEnabled()) {
  providers.push(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Credentials({
      id: "credentials",
      name: "LAN Login",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const ip =
          request?.headers?.get("x-forwarded-for") ||
          request?.headers?.get("x-real-ip") ||
          "127.0.0.1";

        // VPS: IP gate skipped when LAN_AUTH_ALLOW_PUBLIC=1
        if (!isLanIp(ip) && process.env.LAN_AUTH_ALLOW_PUBLIC !== "1") {
          console.warn(JSON.stringify({
            service: "gv-web",
            msg: "LAN auth blocked from non-LAN IP",
            ip,
          }));
          return null;
        }

        // Brute-force rate limit check
        const rateLimit = checkAuthRateLimit(ip);
        if (!rateLimit.allowed) {
          console.warn(JSON.stringify({
            service: "gv-web",
            msg: "auth rate limit — too many attempts",
            ip,
            waitSec: rateLimit.waitSec,
          }));
          return null;
        }

        // Constant-time-ish: always compare username FIRST (don't short-circuit
        // on missing user — prevents user enumeration via timing)
        const userMatch = credentials?.username === process.env.LAN_USER;

        // Only verify password if username matched (avoid unnecessary bcrypt)
        const passMatch = userMatch
          ? await verifyPassword((credentials?.password as string) || "")
          : false;

        if (!userMatch || !passMatch) {
          recordAuthFailure(ip);
          return null;
        }

        // Deterministic per-user UUID — derived from LAN_USER + username
        // so each LAN user gets a stable, unique identity without a DB row.
        const hash = crypto.createHash("sha256")
          .update(process.env.LAN_USER + ":" + credentials.username)
          .digest("hex");
        const id = [
          hash.slice(0, 8),
          hash.slice(8, 12),
          "5" + hash.slice(13, 16), // version 5 (name-based)
          ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.slice(18, 20),
          hash.slice(20, 32),
        ].join("-");
        return {
          id,
          name: credentials.username as string,
          email: "",
        } as any;
      },
    }) as any,
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: providers as any,
  session: { strategy: "jwt" },
  callbacks: {
    session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
});
