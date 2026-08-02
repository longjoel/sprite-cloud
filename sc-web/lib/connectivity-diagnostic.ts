import type { TurnProbeEvidence, TurnProbeState } from "./turn-probe";

export interface ConnectivityDiagnostic {
  mode:
    | "lan-only"
    | "stun-capable"
    | "turn-capable"
    | "misconfigured"
    | "turn-failed";
  /** "all" | "relay" — relay policy applies once TURN is proven reachable. */
  transport_policy: "all" | "relay";
  stun_configured: boolean;
  turn_configured: boolean;
  /** Config-complete AND relay allocation proven by an effective probe. */
  turn_ready: boolean;
  /** Effective probe state: what the configured TURN listener actually proved. */
  turn_state: TurnProbeState;
  /** Sanitized probe evidence (never contains the credential). */
  probe: TurnProbeEvidence | null;
  diagnostics: string[];
}

const DEFAULT_STUN_URL = "stun:stun.l.google.com:19302";

function splitUrls(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getConnectivityDiagnostic(
  probe: TurnProbeEvidence | null = null,
): ConnectivityDiagnostic {
  const stunUrls = splitUrls(process.env.GV_ICE_STUN_URLS);
  const turnUrls = splitUrls(process.env.GV_ICE_TURN_URLS);
  const turnUsername = process.env.GV_ICE_TURN_USERNAME || "";
  const turnCredential = process.env.GV_ICE_TURN_CREDENTIAL || "";
  const transportPolicy = process.env.GV_ICE_TRANSPORT_POLICY === "relay" ? "relay" : "all";

  const stunConfigured = stunUrls.length > 0;
  const turnConfigured = turnUrls.length > 0;
  const configComplete = turnConfigured && !!turnUsername && !!turnCredential;
  const probeRelayed = probe?.state === "relayed";
  const probeFailed = !!probe && (probe.state === "failed" || probe.state === "reachable");
  const diagnostics: string[] = [];

  if (!stunConfigured && !turnConfigured) {
    diagnostics.push(`No STUN/TURN URLs configured — browser falls back to default STUN (${DEFAULT_STUN_URL}).`);
    diagnostics.push("Mode is suitable for LAN or friendly-NAT testing only; remote guest reliability is not guaranteed.");
    return {
      mode: "lan-only",
      transport_policy: transportPolicy,
      stun_configured: false,
      turn_configured: false,
      turn_ready: false,
      turn_state: "unconfigured",
      probe: null,
      diagnostics,
    };
  }

  if (turnConfigured && !configComplete) {
    diagnostics.push("TURN URL is configured but username/credential is missing — relay is not actually usable.");
    diagnostics.push("Fix GV_ICE_TURN_USERNAME and GV_ICE_TURN_CREDENTIAL to make remote guest multiplayer reliable.");
    return {
      mode: "misconfigured",
      transport_policy: transportPolicy,
      stun_configured: stunConfigured,
      turn_configured: true,
      turn_ready: false,
      turn_state: "configured",
      probe,
      diagnostics,
    };
  }

  if (configComplete) {
    if (probeRelayed) {
      diagnostics.push("TURN relay allocation verified by live probe.");
      diagnostics.push(
        transportPolicy === "relay"
          ? "Transport policy is relay, so browsers should prefer TURN for all connections."
          : "Transport policy is all, so browsers may use direct or relay candidates depending on topology.",
      );
      return {
        mode: "turn-capable",
        transport_policy: transportPolicy,
        stun_configured: stunConfigured,
        turn_configured: true,
        turn_ready: true,
        turn_state: "relayed",
        probe,
        diagnostics,
      };
    }

    if (probeFailed) {
      diagnostics.push("TURN is configured but the live probe failed — relay is NOT currently usable.");
      diagnostics.push("Check coturn listener, firewall, credentials, and certificate before remote beta tests.");
      return {
        mode: "turn-failed",
        transport_policy: transportPolicy,
        stun_configured: stunConfigured,
        turn_configured: true,
        turn_ready: false,
        turn_state: probe?.state ?? "failed",
        probe,
        diagnostics,
      };
    }

    diagnostics.push("TURN is configured.");
    if (probe) {
      diagnostics.push(`TURN listener responded (state=${probe.state}) — relay allocation not yet verified.`);
    } else {
      diagnostics.push("Waiting for an effective relay probe before declaring relay readiness.");
    }
    return {
      mode: "turn-capable",
      transport_policy: transportPolicy,
      stun_configured: stunConfigured,
      turn_configured: true,
      turn_ready: probeRelayed,
      turn_state: probe?.state ?? "configured",
      probe,
      diagnostics,
    };
  }

  diagnostics.push("STUN is configured but TURN is not — friendly-NAT play may work, hostile-NAT/cellular guests may fail.");
  diagnostics.push("Add TURN credentials if you want reliable remote guest multiplayer.");
  return {
    mode: "stun-capable",
    transport_policy: transportPolicy,
    stun_configured: true,
    turn_configured: false,
    turn_ready: false,
    turn_state: "unconfigured",
    probe: null,
    diagnostics,
  };
}
