import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function csrfCookieValue(request: NextRequest): string | null {
  const cookie = request.cookies.get("sc_csrf_token");
  return cookie?.value ?? null;
}

export function middleware(request: NextRequest) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-csrf-token");
    response.headers.set("Access-Control-Max-Age", "86400");
    return response;
  }

  const response = NextResponse.next();

  // Allow cross-origin for player pages and API routes
  const path = request.nextUrl.pathname;
  if (path.startsWith("/player/") || path.startsWith("/api/")) {
    response.headers.set("Access-Control-Allow-Origin", "*");
  }

  // Ensure CSRF cookie is always set — generates one server-side so
  // client JS never races with a missing/stale cookie on first load.
  // Only set if missing (never overwrite an existing valid cookie).
  if (!csrfCookieValue(request)) {
    const raw = new Uint8Array(16);
    crypto.getRandomValues(raw);
    const token = Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
    response.cookies.set("sc_csrf_token", token, {
      path: "/",
      sameSite: "lax",
      httpOnly: false, // must be readable by client JS
      secure: process.env.NODE_ENV === "production",
    });
  }

  return response;
}

export const config = {
  matcher: [
    "/player/:path*",
    "/api/:path*",
    "/p/:path*",
    "/xmb",
    "/signin",
    "/setup",
    "/unauthorized",
    "/forbidden",
  ],
};
