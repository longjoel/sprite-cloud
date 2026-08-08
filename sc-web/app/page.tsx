import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import LandingPage from "@/components/LandingPage";
import LibraryClient from "@/components/LibraryClient";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { verifyBearerToken } from "@/lib/server-auth";

// ── Home page — Living Cabinet wall for everyone
// Authenticated users are redirected to /library.
// Unauthenticated visitors see the wall (LandingPage).
// LAN proxy requests get LibraryClient.

export default async function Home() {
  const session = await auth();
  const requestHeaders = await headers();
  const hasLanMarker = requestHeaders.get("x-sc-server-lan") === "1";
  const lanServer = hasLanMarker
    ? await verifyBearerToken(requestHeaders.get("authorization"))
    : null;
  const isLanProxy = lanServer !== null;

  // First-run: if no users exist, show setup
  if (!session?.user?.id) {
    if (isLanProxy) {
      // LAN proxy: bearer-authenticated server owner is admin by claim semantics —
      // pass adminServers so the wall toggles render in the library context menu.
      return (
        <LibraryClient
          serverIds={[]}
          session={null}
          isLanProxy
          adminServers={
            lanServer
              ? [
                  {
                    id: lanServer.id,
                    name: lanServer.name,
                    status:
                      ((lanServer.metadata as Record<string, unknown> | null)
                        ?.status as string) ?? "unknown",
                  },
                ]
              : []
          }
        />
      );
    }
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users);
    if (Number(row?.count ?? 0) === 0) {
      redirect("/setup");
    }
    return (
      <LandingPage
        userName={null}
        authenticated={false}
      />
    );
  }

  // Authenticated
  return (
    <LandingPage
      userName={session.user.name || session.user.email || null}
      authenticated
    />
  );
}
