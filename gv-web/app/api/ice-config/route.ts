import { NextResponse } from "next/server";

// ── GET /api/ice-config ────────────────────────────────────────────────
//
// Returns the shared ICE server policy for browser WebRTC connections.
// When the browser is on the same LAN as gv-server (detected via request IP),
// returns `iceTransportPolicy: "all"` so host candidates are used directly.
// Configured via environment variables on gv-web:
//
//   GV_ICE_STUN_URLS       — comma-separated STUN URLs
//   GV_ICE_TURN_URLS       — comma-separated TURN URLs
//   GV_ICE_TURN_USERNAME   — TURN username
//   GV_ICE_TURN_CREDENTIAL — TURN credential (never logged)
//   GV_ICE_TRANSPORT_POLICY — "all" | "relay"
//   GV_SERVER_LAN_IPS      — comma-separated LAN IPs of gv-server boxes
//
// When no STUN/TURN URLs are configured, returns the Google STUN default.

const DEFAULT_STUN_URL = "stun:stun.l.google.com:19302";

function isLanClient(request: Request | undefined): boolean {
  if (!request) return false;
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "";
  const lanIpsRaw = process.env.GV_SERVER_LAN_IPS || "";
  if (!clientIp || !lanIpsRaw) return false;
  const lanIps = lanIpsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const clientPrefix = clientIp.split(".").slice(0, 3).join(".");
  return lanIps.some((lanIp) => {
    if (lanIp === clientIp) return true;
    const lanPrefix = lanIp.split(".").slice(0, 3).join(".");
    return lanPrefix === clientPrefix;
  });
}

export async function GET(request: Request) {
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
  const policy = process.env.GV_ICE_TRANSPORT_POLICY || "all";
  // Override to "all" when the browser is on the same LAN as gv-server
  // (host candidates are directly reachable — no need for TURN relay)
  const effectivePolicy = isLanClient(request) ? "all" : policy;

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

  return NextResponse.json({
    iceServers,
    iceTransportPolicy: effectivePolicy === "relay" ? "relay" : "all",
  });
}
