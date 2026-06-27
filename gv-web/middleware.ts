import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.headers.set("Access-Control-Max-Age", "86400");
    return response;
  }

  const response = NextResponse.next();

  // Allow cross-origin for player pages and API routes
  const path = request.nextUrl.pathname;
  if (path.startsWith("/player/") || path.startsWith("/api/")) {
    response.headers.set("Access-Control-Allow-Origin", "*");
  }

  return response;
}

export const config = {
  matcher: ["/player/:path*", "/api/:path*", "/signin", "/setup"],
};
