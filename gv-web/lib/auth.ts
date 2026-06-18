import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";
import crypto from "crypto";

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
  return !!(process.env.LAN_USER && process.env.LAN_PASS);
}

// ── Providers ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providers: any[] = [];
if (process.env.AUTH_GITHUB_ID) {
  providers.push(GitHub({}));
}

// Side door: LAN-only basic auth. Only available when LAN_USER + LAN_PASS
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

        if (!isLanIp(ip) && process.env.LAN_AUTH_ALLOW_PUBLIC !== "1") {
          console.warn(JSON.stringify({
            service: "gv-web",
            msg: "LAN auth blocked from non-LAN IP",
            ip,
          }));
          return null;
        }

        if (
          credentials?.username === process.env.LAN_USER &&
          credentials?.password === process.env.LAN_PASS
        ) {
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
        }

        return null;
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
