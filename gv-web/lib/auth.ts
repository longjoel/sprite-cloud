import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// ── Types ──────────────────────────────────────────────────────────────

interface DbUser {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
}

// ── DB helpers ─────────────────────────────────────────────────────────

async function findUserByEmail(email: string): Promise<DbUser | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return (row as DbUser) ?? null;
}

// ── Brute-force rate limiter (in-memory, per-IP) ──────────────────────

const AUTH_MAX_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 60_000;        // 1 minute
const AUTH_BLOCK_MS = 300_000;        // 5-minute block after threshold

interface AttemptEntry {
  failures: number;
  windowStart: number;
  blockedUntil: number;
}

const attempts = new Map<string, AttemptEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, e] of attempts) {
    if (now - e.windowStart > AUTH_BLOCK_MS * 2) attempts.delete(key);
  }
}, 300_000).unref?.();

function checkRateLimit(ip: string): { allowed: boolean; waitSec: number } {
  const now = Date.now();
  let e = attempts.get(ip);
  if (!e) {
    e = { failures: 0, windowStart: now, blockedUntil: 0 };
    attempts.set(ip, e);
  }
  if (e.blockedUntil > 0) {
    if (now < e.blockedUntil) return { allowed: false, waitSec: Math.ceil((e.blockedUntil - now) / 1000) };
    e.blockedUntil = 0; e.failures = 0; e.windowStart = now;
  }
  if (now - e.windowStart > AUTH_WINDOW_MS) {
    e.failures = 0; e.windowStart = now;
  }
  if (e.failures >= AUTH_MAX_ATTEMPTS) {
    e.blockedUntil = now + AUTH_BLOCK_MS;
    return { allowed: false, waitSec: Math.ceil(AUTH_BLOCK_MS / 1000) };
  }
  return { allowed: true, waitSec: 0 };
}

function recordFailure(ip: string) {
  const e = attempts.get(ip);
  if (e) e.failures += 1;
}

// ── Auth config ────────────────────────────────────────────────────────

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      id: "credentials",
      name: "Games Vault",
      credentials: {
        email: { label: "Email", type: "email", placeholder: "you@example.com" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const ip =
          request?.headers?.get("x-forwarded-for") ||
          request?.headers?.get("x-real-ip") ||
          "127.0.0.1";

        const rl = checkRateLimit(ip);
        if (!rl.allowed) return null;

        const email = (credentials?.email as string || "").trim().toLowerCase();
        const password = (credentials?.password as string) || "";
        if (!email || !password) {
          recordFailure(ip);
          return null;
        }

        const user = await findUserByEmail(email);
        if (!user || !user.passwordHash) {
          recordFailure(ip);
          return null;
        }

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) {
          recordFailure(ip);
          return null;
        }

        return { id: user.id, name: user.name || email, email: user.email };
      },
    }),
  ],
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
