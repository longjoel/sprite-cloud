import { NextResponse } from "next/server";

// ── GET /api/ice-config ────────────────────────────────────────────────
//
// Returns the shared ICE server policy for browser WebRTC connections.
//
// Transport selection here is intentionally configuration-driven only.
// sc-web runs on the public internet, so request headers like x-forwarded-for
// and x-real-ip cannot reliably prove that the browser is on the same RFC1918
// LAN as the paired sc-server. Two clients on the same home network often
// appear to sc-web as the same WAN/public IP, which makes gateway-side LAN
// guessing non-deterministic and misleading.
//
// Configured via environment variables on sc-web:
//
//   GV_ICE_STUN_URLS        — comma-separated STUN URLs
//   GV_ICE_TURN_URLS        — comma-separated TURN URLs
//   GV_ICE_TURN_USERNAME    — TURN username
//   GV_ICE_TURN_CREDENTIAL  — TURN credential (never logged)
//   GV_ICE_TRANSPORT_POLICY — "all" | "relay"
//
// When no STUN/TURN URLs are configured, returns the Google STUN default.

const DEFAULT_STUN_URL = "stun:stun.l.google.com:19302";

export async function GET(_request: Request) {
  const stunRaw = process.env.GV_ICE_STUN_URLS || "";
  const turnRaw = process.env.GV_ICE_TURN_URLS || "";
  const stunUrls = stunRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const turnUrls = turnRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const turnUsername = process.env.GV_ICE_TURN_USERNAME || "";
  const turnCredential = process.env.GV_ICE_TURN_CREDENTIAL || "";
  const configuredPolicy = process.env.GV_ICE_TRANSPORT_POLICY || "all";
  const effectivePolicy = configuredPolicy === "relay" ? "relay" : "all";

  const iceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }> = [];

  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls });
  }

  if (turnUrls.length > 0 && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
      username: turnUsername,
      credential: turnCredential,
    });
  } else if (turnUrls.length > 0) {
    console.warn("[ice-config] TURN URL(s) configured but missing username/credential — TURN skipped");
  }

  if (iceServers.length === 0) {
    iceServers.push({ urls: DEFAULT_STUN_URL });
  }

  console.info(
    `[ice-config] transport mode selected: ${effectivePolicy} (source=GV_ICE_TRANSPORT_POLICY, configured=${configuredPolicy || "unset"}, stun_urls=${stunUrls.length || 1}, turn_urls=${turnUrls.length})`,
  );

  return NextResponse.json({
    iceServers,
    iceTransportPolicy: effectivePolicy,
  });
}
