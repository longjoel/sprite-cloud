// Client-only PostHog bootstrap.
//
// LEAK-PROOF BY CONSTRUCTION: PostHog is never initialized unless BOTH
// NEXT_PUBLIC_POSTHOG_KEY and NEXT_PUBLIC_POSTHOG_HOST are configured at
// build time. With either var unset, this module is a no-op: no script
// loads, no events fire, no data leaves the browser. There are no
// hardcoded keys or hosts anywhere in the tree — see
// tests/no-tracked-posthog-secrets.sh for the CI guard.
//
// Privacy posture (matches the app's fail-closed defaults):
//   - session replay is OFF
//   - typed text in inputs is never captured
//   - person profiles are only created for explicitly identified users;
//     we never call identify(), so events stay anonymous
//   - only pageviews + autocaptured clicks/button presses ship

import posthog from "posthog-js";

const configured =
  Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY) &&
  Boolean(process.env.NEXT_PUBLIC_POSTHOG_HOST);

let initialized = false;

/** Initialize PostHog once, on the client, only when fully configured. */
export function initPostHog(): void {
  if (typeof window === "undefined" || initialized || !configured) return;
  initialized = true;
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY as string, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST as string,
    // Button/click telemetry with zero per-button code — Joel's core ask.
    autocapture: true,
    // Pageviews are captured by PostHogProvider on mount + route change,
    // so the SDK's own history listener stays off (no double counts).
    capture_pageview: false,
    // Privacy: never record sessions. Autocapture never transmits typed
    // input values — only element structure/attributes — and no identify()
    // calls are made anywhere, so events stay anonymous (DAU only).
    disable_session_recording: true,
    person_profiles: "identified_only",
    // Host-only cookies: no cross-subdomain probing. PostHog's subdomain
    // discovery sets dmn_chk_* cookies with Domain suffixes, which browsers
    // reject outright on LAN IP pages (Domain=IP is invalid) and which we
    // don't need — analytics never cross subdomains here.
    cross_subdomain_cookie: false,
  });
}

/** True once PostHog is live in this browser session. */
export function isPostHogActive(): boolean {
  return initialized;
}

export { posthog };
