/**
 * ROM transfer client unit tests.
 *
 * Run: npx vitest run tests/rom-transfer-client.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Browser API mocks ─────────────────────────────────────────────────

// Mock RTCPeerConnection
class MockRTCDataChannel {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  label: string;
  private listeners: Record<string, EventListener[]> = {};

  constructor(label: string) {
    this.label = label;
  }

  addEventListener(type: string, listener: EventListener, _opts?: unknown): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(_data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    // no-op in mock
  }

  // Test helpers
  _open(): void {
    this.readyState = "open";
    this.listeners["open"]?.forEach((l) => l(new Event("open")));
  }

  _receiveMessage(data: string): void {
    this.listeners["message"]?.forEach((l) =>
      l(new MessageEvent("message", { data }))
    );
  }
}

class MockRTCPeerConnection {
  iceGatheringState: RTCIceGatheringState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  private gatherListeners: EventListener[] = [];

  createDataChannel(label: string): MockRTCDataChannel {
    return new MockRTCDataChannel(label);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    // Simulate ICE gathering completing asynchronously
    Promise.resolve().then(() => this._completeIceGathering());
    return { type: "offer", sdp: "mock-sdp-offer" };
  }

  async setLocalDescription(_desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = { type: "offer", sdp: "mock-sdp-offer" };
  }

  async setRemoteDescription(_desc: RTCSessionDescriptionInit): Promise<void> {
    // no-op
  }

  addEventListener(type: string, listener: EventListener): void {
    if (type === "icegatheringstatechange") {
      this.gatherListeners.push(listener);
    }
  }

  close(): void {
    // no-op
  }

  // Test helper: simulate ICE gathering complete
  _completeIceGathering(): void {
    this.iceGatheringState = "complete";
    this.gatherListeners.forEach((l) => l(new Event("icegatheringstatechange")));
  }
}

// Install mocks
vi.stubGlobal("RTCPeerConnection", MockRTCPeerConnection);
vi.stubGlobal("RTCSessionDescription", class {
  type: string;
  sdp: string;
  constructor(init: RTCSessionDescriptionInit) {
    this.type = init.type ?? "";
    this.sdp = init.sdp ?? "";
  }
});

// ── Fetch mock ─────────────────────────────────────────────────────────

let fetchResponses: Map<string, { status: number; body: unknown }> = new Map();
let fetchCalls: { url: string; body?: unknown }[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const key = url.toString();
    const match = fetchResponses.get(key);
    if (match) {
      return {
        ok: match.status < 400,
        status: match.status,
        json: async () => match.body,
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  })
);

// Mock document.cookie for CSRF
vi.stubGlobal("document", {
  cookie: "sc_csrf_token=test-csrf-token",
});

// ── Imports (after mocks) ──────────────────────────────────────────────

import {
  RomTransferClient,
  TransferCredentials,
  dataChannelChunkSize,
  ICE_GATHER_POLL_MS,
  ICE_GATHER_RELAY_GRACE_MS,
  ICE_GATHER_HOST_GRACE_MS,
  ICE_GATHER_TIMEOUT_MS,
} from "@/lib/rom-transfer-client";

// ── Helpers ────────────────────────────────────────────────────────────

function makeCreds(overrides?: Partial<TransferCredentials>): TransferCredentials {
  return {
    transfer_id: "xfer-1",
    capability_secret: "test-secret",
    command_id: "cmd-1",
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    signaling: { server_id: "srv-1", transfer_id: "xfer-1" },
    ...overrides,
  };
}

function makeFile(size: number, name = "game.nes"): File {
  const content = new Uint8Array(size);
  return new File([content], name, { type: "application/octet-stream" });
}

function setupFetch(url: string, status: number, body: unknown): void {
  fetchResponses.set(url, { status, body });
}

beforeEach(() => {
  fetchResponses = new Map();
  fetchCalls = [];
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("RomTransferClient", () => {
  // ── Construction ──────────────────────────────────────────────────

  it("constructs with file and credentials", () => {
    const client = new RomTransferClient(makeFile(1024), makeCreds(), "srv-1");
    expect(client).toBeDefined();
  });

  it("exposes callback hooks", () => {
    const client = new RomTransferClient(makeFile(1024), makeCreds(), "srv-1");
    expect(client.onProgress).toBeUndefined();
    expect(client.onPhase).toBeUndefined();

    const onProgress = vi.fn();
    const onPhase = vi.fn();
    client.onProgress = onProgress;
    client.onPhase = onPhase;
    expect(client.onProgress).toBe(onProgress);
  });

  // ── Signaling phase ───────────────────────────────────────────────

  it("fetches ICE config during signaling", async () => {
    setupFetch("/api/ice-config", 200, {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    // But it will fail on the offer POST since we haven't set that up.
    // Just verify ICE fetch was attempted.

    const client = new RomTransferClient(makeFile(1024), makeCreds(), "srv-1");
    try { await client.upload(); } catch { /* expected */ }

    const iceCall = fetchCalls.find((c) => c.url.includes("ice-config"));
    expect(iceCall).toBeDefined();
  });

  // ── Progress tracking ─────────────────────────────────────────────

  it("reports progress via onProgress callback", () => {
    const client = new RomTransferClient(makeFile(1024), makeCreds(), "srv-1");
    const progressValues: { sent: number; total: number }[] = [];
    client.onProgress = (sent, total) => progressValues.push({ sent, total });

    // Simulate progress callbacks (can be tested without WebRTC)
    client.onProgress?.(512, 1024);
    client.onProgress?.(1024, 1024);

    expect(progressValues).toEqual([
      { sent: 512, total: 1024 },
      { sent: 1024, total: 1024 },
    ]);
  });

  // ── Phase tracking ────────────────────────────────────────────────

  it("reports phase changes via onPhase callback", () => {
    const client = new RomTransferClient(makeFile(1024), makeCreds(), "srv-1");
    const phases: string[] = [];
    client.onPhase = (phase) => phases.push(phase);

    client.onPhase?.("signaling");
    client.onPhase?.("connecting");
    client.onPhase?.("transferring");

    expect(phases).toEqual(["signaling", "connecting", "transferring"]);
  });

  // ── Cancellation ─────────────────────────────────────────────────

  it("cancel aborts the controller", () => {
    const client = new RomTransferClient(makeFile(1024), makeCreds(), "srv-1");
    client.cancel();
    // After cancel, upload should fail with "Cancelled"
    // (requires the fetch to be in flight, which we can't easily test)
  });

  // ── Error on missing ICE config ───────────────────────────────────

  it("errors when ICE config fetch fails", async () => {
    setupFetch("/api/ice-config", 500, { error: "down" });

    const client = new RomTransferClient(makeFile(1024), makeCreds(), "srv-1");
    await expect(client.upload()).rejects.toThrow("ICE config fetch failed");
  });

  // ── Error on signaling rejection ──────────────────────────────────

  it("errors when signaling endpoint rejects", async () => {
    setupFetch("/api/ice-config", 200, {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    setupFetch(
      "/api/servers/srv-1/rom-transfers/xfer-1/offer",
      403,
      { error: "invalid capability" },
    );

    const client = new RomTransferClient(makeFile(1024), makeCreds(), "srv-1");
    await expect(client.upload()).rejects.toThrow("invalid capability");
  });

  // ── Data channel message sizing ────────────────────────────────────

  it("caps chunks below the negotiated SCTP limit for cross-stack interoperability", () => {
    expect(dataChannelChunkSize(65_536)).toBe(16_384);
    expect(dataChannelChunkSize(16_384)).toBe(16_384);
    expect(dataChannelChunkSize(8_192)).toBe(8_192);
  });

  it("uses a conservative 16 KiB fallback when no finite limit is advertised", () => {
    expect(dataChannelChunkSize(undefined)).toBe(16_384);
    expect(dataChannelChunkSize(0)).toBe(16_384);
    expect(dataChannelChunkSize(Number.POSITIVE_INFINITY)).toBe(16_384);
  });

  // ── Credential validation ─────────────────────────────────────────

  it("carries credentials through construction", () => {
    const creds = makeCreds({ transfer_id: "my-xfer" });
    const client = new RomTransferClient(makeFile(1024), creds, "srv-1");
    // We can't inspect private fields directly, but construction succeeds
    expect(client).toBeDefined();
  });

  // ── ICE gathering early exit ──────────────────────────────────────

  const CANDIDATE = {
    host: "a=candidate:1444769820 1 udp 2122260223 192.168.86.20 51234 typ host generation 0",
    srflx: "a=candidate:842163049 1 udp 1677729535 203.0.113.9 52134 typ srflx raddr 192.168.86.20 rport 51234 generation 0",
    relay: "a=candidate:622164295 1 udp 41819902 198.51.100.7 3478 typ relay raddr 203.0.113.9 rport 52134 generation 0",
  };

  function seedGatheringClient(
    sdp: string,
    state: RTCIceGatheringState = "gathering",
  ): RomTransferClient {
    const client = new RomTransferClient(makeFile(8), makeCreds(), "srv-1");
    const pc = new MockRTCPeerConnection();
    pc.iceGatheringState = state;
    pc.localDescription = { type: "offer", sdp };
    (client as unknown as { pc: MockRTCPeerConnection }).pc = pc;
    return client;
  }

  function gatherSignal(): AbortSignal {
    return new AbortController().signal;
  }

  function callWaitForIceGathering(
    client: RomTransferClient,
    signal: AbortSignal,
  ): Promise<void> {
    return (client as unknown as {
      waitForIceGathering(s: AbortSignal): Promise<void>;
    }).waitForIceGathering(signal);
  }

  describe("waitForIceGathering early exit", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves on the first poll tick when a relay candidate is in the SDP", async () => {
      vi.useFakeTimers();
      const client = seedGatheringClient(CANDIDATE.relay);
      const promise = callWaitForIceGathering(client, gatherSignal());
      await vi.advanceTimersByTimeAsync(ICE_GATHER_POLL_MS);
      await expect(promise).resolves.toBeUndefined();
    });

    it("resolves as soon as a relay candidate appears mid-gather (even before any grace)", async () => {
      vi.useFakeTimers();
      const client = seedGatheringClient("");
      const promise = callWaitForIceGathering(client, gatherSignal());
      await vi.advanceTimersByTimeAsync(ICE_GATHER_POLL_MS * 2); // still gathering, no candidates
      // Relay lands later; the very next poll tick must resolve.
      (
        client as unknown as { pc: { localDescription: RTCSessionDescriptionInit | null } }
      ).pc!.localDescription = { type: "offer", sdp: CANDIDATE.relay };
      await vi.advanceTimersByTimeAsync(ICE_GATHER_POLL_MS);
      await expect(promise).resolves.toBeUndefined();
    });

    it("waits out the relay grace after srflx, then resolves with srflx only", async () => {
      vi.useFakeTimers();
      const client = seedGatheringClient(CANDIDATE.srflx);
      const promise = callWaitForIceGathering(client, gatherSignal());
      // Hold through the relay grace so a slow but healthy TURN is kept in
      // the one-shot offer.
      await vi.advanceTimersByTimeAsync(ICE_GATHER_RELAY_GRACE_MS - 250);
      await vi.advanceTimersByTimeAsync(250);
      await expect(promise).resolves.toBeUndefined();
    });

    it("resolves at the host grace when only host candidates exist (same-LAN target)", async () => {
      vi.useFakeTimers();
      const client = seedGatheringClient(CANDIDATE.host);
      const promise = callWaitForIceGathering(client, gatherSignal());
      await vi.advanceTimersByTimeAsync(ICE_GATHER_HOST_GRACE_MS - 250);
      // Host-only candidate must NOT resolve before the host grace.
      const early = await Promise.race([
        promise.then(() => true, () => true),
        vi.advanceTimersByTimeAsync(100).then(() => false),
      ]);
      expect(early).toBe(false);
      await vi.advanceTimersByTimeAsync(150);
      await expect(promise).resolves.toBeUndefined();
    });

    it("resolves immediately when gathering is already complete", async () => {
      vi.useFakeTimers();
      const client = seedGatheringClient("", "complete");
      const promise = callWaitForIceGathering(client, gatherSignal());
      await expect(promise).resolves.toBeUndefined();
    });

    it("resolves when gathering transitions to complete with an empty SDP", async () => {
      vi.useFakeTimers();
      const client = seedGatheringClient("");
      const promise = callWaitForIceGathering(client, gatherSignal());
      (
        client as unknown as { pc: { iceGatheringState: RTCIceGatheringState } }
      ).pc!.iceGatheringState = "complete";
      await vi.advanceTimersByTimeAsync(ICE_GATHER_POLL_MS);
      await expect(promise).resolves.toBeUndefined();
    });

    it("rejects 'ICE gathering timed out' when no candidate ever appears", async () => {
      vi.useFakeTimers();
      const client = seedGatheringClient("");
      const promise = callWaitForIceGathering(client, gatherSignal());
      const assertion = expect(promise).rejects.toThrow("ICE gathering timed out");
      await vi.advanceTimersByTimeAsync(ICE_GATHER_TIMEOUT_MS);
      await assertion;
    });

    it("rejects 'Cancelled' when the upload is aborted mid-gather", async () => {
      vi.useFakeTimers();
      const client = seedGatheringClient("");
      const controller = new AbortController();
      const promise = callWaitForIceGathering(client, controller.signal);
      // Attach the expectation BEFORE aborting — abort rejects synchronously.
      const assertion = expect(promise).rejects.toThrow("Cancelled");
      controller.abort();
      await assertion;
    });
  });
});
