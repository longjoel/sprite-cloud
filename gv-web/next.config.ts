import type { NextConfig } from "next";

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob:",
  "img-src 'self' data:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  // ESLint is intentionally disabled during builds. TypeScript (npx tsc --noEmit)
  // is the enforcement gate for code quality. ESLint would require configuring a
  // full rule set for this project, and the recurring "ESLint must be installed"
  // warning trained maintainers to ignore build output — the opposite of its intent.
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: "/player/:path*",
        headers: [
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Pragma",
            value: "no-cache",
          },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: CSP,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
