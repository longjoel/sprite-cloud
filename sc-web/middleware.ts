import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function csrfCookieValue(request: NextRequest): string | null {
  const cookie = request.cookies.get("sc_csrf_token");
  return cookie?.value ?? null;
}

export function middleware(request: NextRequest) {
  // Legacy request-time caches were written under public/covers. Do not allow
  // pre-existing artifacts to bypass the server-scoped authorization route.
  if (request.nextUrl.pathname.startsWith("/covers/")) {
    return new NextResponse("not found", { status: 404 });
  }

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
  // Covers are authenticated, server-scoped assets. Never make them readable
  // cross-origin even though the rest of the player/API surface supports CORS.
  if ((path.startsWith("/player/") || path.startsWith("/api/")) && !path.startsWith("/api/covers/")) {
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
    "/covers/:path*",
    "/p/:path*",
    "/r/:path*",
    "/servers/:path*",
    "/signin",
    "/setup",
    "/invite/:path*",
    "/unauthorized",
    "/forbidden",
  ],
};
