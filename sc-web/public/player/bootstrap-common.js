// Shared browser-player bootstrap helpers.
//
// Canonical browser player bootstrap lives in play-v2.js (used by GamePlayer.tsx).
// Keep ICE config loading + startup diagnostics here so all active browser-player
// flows share the same transport semantics.

const DEFAULT_ICE_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  iceTransportPolicy: "all",
};

export async function fetchEffectiveIceConfig() {
  try {
    const resp = await fetch("/api/ice-config");
    if (resp.ok) {
      const cfg = await resp.json();
      const iceServers = Array.isArray(cfg?.iceServers) && cfg.iceServers.length > 0
        ? cfg.iceServers
        : DEFAULT_ICE_CONFIG.iceServers;
      const iceTransportPolicy = cfg?.iceTransportPolicy === "relay" ? "relay" : "all";
      return { iceServers, iceTransportPolicy, source: "api" };
    }
    console.warn("[gv] /api/ice-config returned HTTP", resp.status);
  } catch (e) {
    console.warn("[gv] /api/ice-config unreachable:", e?.message || e);
  }
  console.warn("[gv] ICE: using Google STUN fallback — no TURN, NAT may fail");
  return { ...DEFAULT_ICE_CONFIG, source: "fallback" };
}

export function logBootstrapStart({ path, flow, iceServers, iceTransportPolicy, source }) {
  console.log(
    `[gv-bootstrap] path=${path} flow=${flow} ice_servers=${iceServers?.length || 0} policy=${iceTransportPolicy || "all"} source=${source || "unknown"}`,
  );
}
