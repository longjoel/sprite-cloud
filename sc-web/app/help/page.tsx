import { auth } from "@/lib/auth";
import HelpPage from "@/components/HelpPage";
import { headers } from "next/headers";
import { verifyBearerToken } from "@/lib/server-auth";

export default async function Help() {
  const session = await auth();
  const requestHeaders = await headers();
  const hasLanMarker = requestHeaders.get("x-sc-server-lan") === "1";
  const lanServer = hasLanMarker
    ? await verifyBearerToken(requestHeaders.get("authorization"))
    : null;
  return (
    <HelpPage
      userName={session?.user?.name || session?.user?.email || null}
      authenticated={!!session?.user?.id}
      isLanProxy={lanServer !== null}
    />
  );
}
