export interface MultiplayerScenarioEvidence {
  connectionSuccess: string;
  transportRoute: string;
  connectTime: string;
  mediaAndDataChannel: string;
}

export interface MultiplayerScenarioLogGuidance {
  browser: string[];
  gvWeb: string[];
  gvServer: string[];
  coturn: string[];
}

export interface MultiplayerVerificationScenario {
  id:
    | "same-machine-two-browsers"
    | "remote-friendly-nat"
    | "same-lan-as-gv-server"
    | "cross-network-hostile-nat-or-cellular";
  title: string;
  whyItExists: string;
  automation: string[];
  manualProcedure: string[];
  passEvidence: MultiplayerScenarioEvidence;
  logGuidance: MultiplayerScenarioLogGuidance;
}

const scenarios: MultiplayerVerificationScenario[] = [
  {
    id: "same-machine-two-browsers",
    title: "Scenario 1 — host and guest in two browsers on the same machine",
    whyItExists:
      "This is the fastest regression detector for bootstrap, room-join, guest SDP, and per-command answer routing.",
    automation: [
      "Run `pnpm vitest run tests/api/routes.test.ts tests/multiplayer/matrix.test.ts` to verify host-start, room-join, guest-token reuse, and signaling-stage expectations.",
      "Run `pnpm vitest run tests/integration/lifecycle-db.test.ts` when Postgres-backed lifecycle evidence is available to confirm session and command state transitions.",
    ],
    manualProcedure: [
      "Open the host flow in one browser profile and the guest link in another profile on the same machine.",
      "Verify both players receive video, input/data-channel events, and stable session state without reconnect loops.",
    ],
    passEvidence: {
      connectionSuccess: "Host starts successfully and guest link resolves to a live session without 4xx/5xx responses.",
      transportRoute: "Browser WebRTC stats or console logs show the selected ICE candidate pair / route classification.",
      connectTime: "Capture wall-clock time from host start to guest media first-frame and note regressions.",
      mediaAndDataChannel: "Both browsers receive media and the guest data channel opens for input delivery.",
    },
    logGuidance: {
      browser: [
        "Capture `[gv]` bootstrap logs and `[SIGNAL]` flow/stage logs from host and guest tabs.",
        "Inspect WebRTC internals/stats for selected candidate pair and data-channel state.",
      ],
      gvWeb: [
        "Inspect `/api/server/command`, `/api/room/join`, and `/api/server/notify` logs for matching command/session IDs.",
        "Confirm launch events and signaling flow/stage sequence line up end-to-end.",
      ],
      gvServer: [
        "Inspect `[SIGNAL] flow=host_start|guest_offer|host_reconnect` logs and any SDP/session warnings.",
      ],
      coturn: [
        "Usually low-signal for same-machine tests, but confirm no unexpected TURN allocation errors if relay is selected.",
      ],
    },
  },
  {
    id: "remote-friendly-nat",
    title: "Scenario 2 — both players remote on friendly NATs / normal home internet",
    whyItExists:
      "This covers the common real-world guest case where relay is optional but connectivity still depends on deterministic signaling and ICE policy.",
    automation: [],
    manualProcedure: [
      "Start a host session from one home network and join from a second remote home network using the guest link.",
      "Record whether the chosen route is direct or relayed and whether either side needed a reconnect.",
    ],
    passEvidence: {
      connectionSuccess: "Guest joins successfully from a second home network without manual server-side intervention.",
      transportRoute: "Selected route is captured from browser stats/logs as host-candidate pair or TURN relay usage.",
      connectTime: "Measure time from guest open to first frame / playable state and compare against baseline.",
      mediaAndDataChannel: "Remote guest receives media and data-channel input works in both directions where applicable.",
    },
    logGuidance: {
      browser: [
        "Capture host + guest console logs, especially bootstrap/signaling stages and any ICE failure transitions.",
      ],
      gvWeb: [
        "Check room join, command insert, notify, and SDP-answer resolution logs for the shared command/session IDs.",
      ],
      gvServer: [
        "Check host_start / guest_offer stage logs and whether gv-server reports fresh PC swaps or missing sessions.",
      ],
      coturn: [
        "If relay is selected or fallback occurs, confirm TURN allocations succeed and credentials/realm match expectations.",
      ],
    },
  },
  {
    id: "same-lan-as-gv-server",
    title: "Scenario 3 — both players on the same LAN as the gv-server host",
    whyItExists:
      "This is the scenario most likely to regress when transport-selection logic or local-route assumptions change.",
    automation: [],
    manualProcedure: [
      "Run host and guest from devices on the same LAN as gv-server and use the normal public site + guest link flow.",
      "Record whether the selected route remains stable and whether media/input survive the local-network path.",
    ],
    passEvidence: {
      connectionSuccess: "Both LAN-local players connect without requiring gateway-side IP inference hacks.",
      transportRoute: "Selected candidate pair indicates the actual local/direct/relay path used on the LAN.",
      connectTime: "Measure time to first frame and compare with same-machine baseline for obvious regressions.",
      mediaAndDataChannel: "Host and guest both receive media and guest input arrives over the data channel.",
    },
    logGuidance: {
      browser: [
        "Capture console + WebRTC stats from both LAN clients to verify candidate-pair selection.",
      ],
      gvWeb: [
        "Verify signaling-stage logs do not rely on removed gateway-side LAN autodetection heuristics.",
      ],
      gvServer: [
        "Check session/SDP stage logs for whether a direct path succeeds without reconnect churn.",
      ],
      coturn: [
        "If TURN is unexpectedly used, inspect allocation logs to understand why a LAN-local path did not win.",
      ],
    },
  },
  {
    id: "cross-network-hostile-nat-or-cellular",
    title: "Scenario 4 — players on different networks including hostile NAT / cellular",
    whyItExists:
      "This is the hardest connectivity case and the one that proves whether the product can work for non-expert self-hosters outside ideal home-network conditions.",
    automation: [],
    manualProcedure: [
      "Join a host session from a guest device on cellular or another hostile-NAT network.",
      "Record whether the path succeeds directly, falls back to TURN relay, or fails, and attach the required logs.",
    ],
    passEvidence: {
      connectionSuccess: "Session reaches a playable guest state from a hostile-NAT or cellular network.",
      transportRoute: "Evidence clearly shows whether TURN relay was selected or whether negotiation failed before route selection.",
      connectTime: "Measure time to connect under adverse conditions and note whether retries/reconnects were required.",
      mediaAndDataChannel: "Remote hostile-network guest gets media and the input/data channel opens or the failure mode is explicit.",
    },
    logGuidance: {
      browser: [
        "Capture console logs, ICE candidate failures, and selected route stats from the hostile-network guest.",
      ],
      gvWeb: [
        "Capture full signaling-stage sequence and any command/session timeout or missing-answer logs.",
      ],
      gvServer: [
        "Capture host_start / guest_offer / host_reconnect logs plus any SDP or session-missing warnings.",
      ],
      coturn: [
        "Mandatory: inspect TURN allocation/auth logs to prove whether relay fallback was available and accepted.",
      ],
    },
  },
];

export function getMultiplayerVerificationMatrix(): MultiplayerVerificationScenario[] {
  return scenarios;
}
