import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// Stable client bootstrap endpoint. sc-web owns account, server membership,
// and signaling configuration only. Game-library data is fetched directly
// from sc-server and never enters the cloud bootstrap payload.
export async function GET() {
  const stunRaw = process.env.GV_ICE_STUN_URLS || "";
  const turnRaw = process.env.GV_ICE_TURN_URLS || "";
  const turnUsername = process.env.GV_ICE_TURN_USERNAME || "";
  const turnCredential = process.env.GV_ICE_TURN_CREDENTIAL || "";
  const configuredPolicy = process.env.GV_ICE_TRANSPORT_POLICY || "all";
  const ice = {
    stunConfigured: stunRaw.trim().length > 0,
    turnConfigured: turnRaw.trim().length > 0 && turnUsername.length > 0 && turnCredential.length > 0,
    transportPolicy: configuredPolicy === "relay" ? "relay" as const : "all" as const,
  };

  const features = {
    pwa: true,
    guestPlay: true,
    multiController: true,
  };
  const deepLinks = {
    hostPattern: "/p/:code",
    guestPattern: "/p/:code?join",
    resolvePattern: "/p/:code",
  };

  const session = await auth().catch(() => null);
  const base = {
    version: process.env.NEXT_PUBLIC_APP_VERSION || "0.2.0",
    auth: session?.user?.id
      ? {
          authenticated: true as const,
          userId: session.user.id,
          name: session.user.name ?? undefined,
          email: session.user.email ?? undefined,
        }
      : { authenticated: false as const },
    ice,
    features,
    deepLinks,
  };

  if (!session?.user?.id) {
    return NextResponse.json({ ...base, servers: [], library: null });
  }

  const memberships = await db
    .select({
      id: servers.id,
      name: servers.name,
      lastSeenAt: servers.lastSeenAt,
      role: serverMembers.role,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, session.user.id));

  return NextResponse.json({
    ...base,
    servers: memberships.map((membership) => ({
      id: membership.id,
      name: membership.name,
      lastSeenAt: membership.lastSeenAt?.toISOString() ?? null,
      role: membership.role,
    })),
    library: null,
  });
}
