import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";

// ── LAN IP gate ───────────────────────────────────────────────────────

const LAN_CIDRS = ["127.", "10.", "192.168.", "172.16.", "172.17.", "172.18.",
  "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
  "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31."];

function isLanIp(ip: string): boolean {
  const clean = ip.split(",")[0]!.trim(); // x-forwarded-for may be chained
  return LAN_CIDRS.some((prefix) => clean.startsWith(prefix)) || clean === "::1";
}

// ── LAN credentials ───────────────────────────────────────────────────

function lanCredentialsEnabled(): boolean {
  return !!(process.env.LAN_USER && process.env.LAN_PASS);
}

// ── Providers ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providers: any[] = [GitHub({})];

// Side door: LAN-only basic auth. Only available when LAN_USER + LAN_PASS
// are set. Requests from non-LAN IPs are rejected — this isn't a backdoor,
// it's a convenience for people already on the trusted network.
if (lanCredentialsEnabled()) {
  providers.push(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Credentials({
      id: "lan",
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

        if (!isLanIp(ip)) {
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
          // Return a synthetic user — no real account, no DB row.
          // The `sub` is stable so the JWT session persists.
          return {
            id: "lan-user",
            name: credentials.username as string,
            email: "",
          } as any; // cast: NextAuth v5 beta credentials typing is loose
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
