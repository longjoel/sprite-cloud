import type { NextConfig } from "next";

// PostHog is strictly env-gated: the analytics host is only added to the
// CSP when NEXT_PUBLIC_POSTHOG_HOST was present at build time. Unset → the
// CSP stays fully closed (no external connect-src), matching the app's
// fail-closed posture and the no-tracked-secrets CI guard.
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
// posthog-js loads its runtime config (config.js) from the PostHog assets
// CDN (e.g. https://us-assets.i.posthog.com) when api_host is a regional
// host like https://us.i.posthog.com. Derive it so the CSP stays in sync.
const posthogAssetsHost = posthogHost?.replace(".i.posthog.com", "-assets.i.posthog.com");

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval'${posthogAssetsHost ? ` ${posthogAssetsHost}` : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ws: wss:${posthogHost ? ` ${posthogHost}` : ""}${posthogAssetsHost ? ` ${posthogAssetsHost}` : ""}`,
  "media-src 'self' blob:",
  "img-src 'self' data:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  // Instrumentation hook (instrumentation.ts) runs at startup — generates
  // the setup code for first-run admin creation on both dev and production.
  // ESLint is intentionally disabled during builds. TypeScript (npx tsc --noEmit)
  // is the enforcement gate for code quality. ESLint would require configuring a
  // full rule set for this project, and the recurring "ESLint must be installed"
  // warning trained maintainers to ignore build output — the opposite of its intent.
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      // Aggressive no-cache for all HTML pages — mobile browsers are stubborn
      {
        source: "/:path((?!api|_next|player|favicon).*)",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, proxy-revalidate" },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
        ],
      },
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
        source: "/invite/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      // Embeddable watch pages (#781): /embed/<slug> is designed to be
      // iframed on third-party sites. The global CSP below would otherwise
      // set frame-ancestors 'none' (last matching rule wins for the same
      // header key), so the global rule EXCLUDES /embed and this dedicated
      // rule supplies the relaxed CSP instead.
      {
        source: "/embed/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: CSP.replace("frame-ancestors 'none'", "frame-ancestors *"),
          },
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
        ],
      },
      {
        source: "/:path((?!embed).*)",
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
