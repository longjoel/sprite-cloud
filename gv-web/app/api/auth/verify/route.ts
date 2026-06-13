import { NextResponse } from "next/server";
import { verifyBearerToken, unauthorizedResponse } from "@/lib/server-auth";

// GET /api/auth/verify — gv-server verifies its API key is valid
export async function GET(request: Request) {
  const server = await verifyBearerToken(request.headers.get("authorization"));
  if (!server) return unauthorizedResponse();

  return NextResponse.json({
    server_id: server.id,
    user_id: server.userId,
    name: server.name,
  });
}
