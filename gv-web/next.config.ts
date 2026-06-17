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
  async headers() {
    return [
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
