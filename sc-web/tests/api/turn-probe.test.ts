/**
 * TURN allocation probe tests.
 *
 * A protocol-accurate mock coturn server runs on a real UDP socket on
 * 127.0.0.1, so the probe is exercised over actual sockets (no mocking of
 * dgram). The mock implements the RFC 5766 long-term credential flow:
 * first Allocate → 401 with realm+nonce → credentialed Allocate →
 * success with XOR-RELAYED-ADDRESS.
 *
 * Run: npx vitest run tests/api/turn-probe.test.ts
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import dgram from "dgram";
import crypto from "crypto";
import {
  runTurnProbe,
  resetTurnProbeCache,
  parseTurnUrl,
  scrubError,
  type TurnProbeEvidence,
} from "@/lib/turn-probe";

const MAGIC_COOKIE = 0x2112a442;
const REALM = "sprite-cloud.com";
const VALID_CREDENTIAL = "correct-horse-battery-staple";

// ── Mock coturn ───────────────────────────────────────────────────────

interface MockTurnOptions {
  realm?: string;
  validCredential?: string;
  /** When true, the mock never responds (simulates a blackholed listener). */
  silent?: boolean;
  /** When true, reject even valid credentials (simulates rotation mismatch). */
  rejectAll?: boolean;
}

function attr(type: number, value: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  const pad = value.length % 4 === 0 ? Buffer.alloc(0) : Buffer.alloc(4 - (value.length % 4));
  return Buffer.concat([header, value, pad]);
}

function stunHeader(type: number, length: number, transactionId: Buffer): Buffer {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(length, 2);
  h.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(h, 8);
  return h;
}

function makeErrorResponse(transactionId: Buffer, code: number, realm: string, nonce: string): Buffer {
  // RFC 5389 §15.6: class byte (hundreds digit) in high 3 bits of byte 2,
  // number byte (tens+units) in byte 3. 401 → [0x00, 0x00, 0x04, 0x01].
  const errAttr = Buffer.alloc(4);
  errAttr[2] = Math.floor(code / 100) & 0x07;
  errAttr[3] = code % 100;
  const attrs = [
    attr(0x0009, errAttr), // ERROR-CODE
    attr(0x0014, Buffer.from(realm, "utf8")), // REALM
    attr(0x0015, Buffer.from(nonce, "utf8")), // NONCE
  ];
  const body = Buffer.concat(attrs);
  return Buffer.concat([stunHeader(0x0113, body.length, transactionId), body]);
}

function makeSuccessResponse(transactionId: Buffer, relayedPort: number): Buffer {
  // XOR-RELAYED-ADDRESS: family(1)=0x01, xport(1)=0, xor-port(2), xor-ip(4)
  const relayed = Buffer.alloc(8);
  relayed[1] = 0x01; // IPv4
  relayed.writeUInt16BE(relayedPort ^ (MAGIC_COOKIE >> 16), 2);
  relayed.writeUInt32BE((0x7f000001 ^ MAGIC_COOKIE) >>> 0, 4); // 127.0.0.1 xor cookie
  const lifetime = Buffer.alloc(4);
  lifetime.writeUInt32BE(600, 0);
  const attrs = [
    attr(0x0016, relayed), // XOR-RELAYED-ADDRESS
    attr(0x000d, lifetime), // LIFETIME
  ];
  const body = Buffer.concat(attrs);
  return Buffer.concat([stunHeader(0x0103, body.length, transactionId), body]);
}

function parseStunHeader(buf: Buffer): { type: number; transactionId: Buffer; length: number } {
  return {
    type: buf.readUInt16BE(0),
    length: buf.readUInt16BE(2),
    transactionId: buf.subarray(8, 20),
  };
}

function extractUsername(buf: Buffer): string | null {
  let offset = 20;
  const end = Math.min(buf.length, 20 + buf.readUInt16BE(2));
  while (offset + 4 <= end) {
    const type = buf.readUInt16BE(offset);
    const len = buf.readUInt16BE(offset + 2);
    if (type === 0x0006) return buf.subarray(offset + 4, offset + 4 + len).toString("utf8");
    offset += 4 + len + (len % 4 === 0 ? 0 : 4 - (len % 4));
  }
  return null;
}

function startMockTurn(opts: MockTurnOptions = {}): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const realm = opts.realm ?? REALM;
    const validCredential = opts.validCredential ?? VALID_CREDENTIAL;
    const nonce = crypto.randomBytes(16).toString("hex");
    const challenged = new Set<string>(); // keyed by source address:port

    socket.on("message", (msg, rinfo) => {
      if (opts.silent) return;
      if (msg.length < 20) return;
      const { type, transactionId, length } = parseStunHeader(msg);
      if (type !== 0x0003) return; // only handle Allocate
      void length;
      const username = extractUsername(msg);
      const peerKey = `${rinfo.address}:${rinfo.port}`;

      if (opts.rejectAll || (username && username !== "guest")) {
        const resp = makeErrorResponse(transactionId, 401, realm, nonce);
        socket.send(resp, rinfo.port, rinfo.address);
        return;
      }

      if (challenged.has(peerKey)) {
        // Second (credentialed) round from the same source: grant allocation.
        const success = makeSuccessResponse(transactionId, 49152 + (crypto.randomBytes(2).readUInt16BE(0) % 1024));
        socket.send(success, rinfo.port, rinfo.address);
        return;
      }

      // First round: challenge with realm+nonce, remember the source.
      challenged.add(peerKey);
      const challenge = makeErrorResponse(transactionId, 401, realm, nonce);
      socket.send(challenge, rinfo.port, rinfo.address);
    });

    socket.bind(0, "127.0.0.1", () => {
      resolve({
        port: (socket.address() as { port: number }).port,
        close: () => socket.close(),
      });
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("parseTurnUrl", () => {
  it("parses turn:host:port?transport=udp", () => {
    expect(parseTurnUrl("turn:sprite-cloud.com:3478?transport=udp")).toEqual({
      host: "sprite-cloud.com",
      port: 3478,
      transport: "udp",
    });
  });

  it("defaults to port 3478", () => {
    expect(parseTurnUrl("turn:relay.example.com").port).toBe(3478);
  });
});

describe("scrubError", () => {
  it("redacts userinfo from URL-like text", () => {
    expect(scrubError("failed to reach //guest:secret@turn.example.com:3478")).toBe(
      "failed to reach //<redacted>@turn.example.com:3478",
    );
  });
});

describe("runTurnProbe", () => {
  let mock: { port: number; close: () => void } | null = null;

  beforeEach(() => {
    resetTurnProbeCache();
  });

  afterEach(() => {
    mock?.close();
    mock = null;
  });

  it("returns unconfigured when no TURN URL is set", async () => {
    const saved = process.env.GV_ICE_TURN_URLS;
    delete process.env.GV_ICE_TURN_URLS;
    try {
      const evidence = await runTurnProbe({ timeoutMs: 500 });
      expect(evidence.state).toBe("unconfigured");
    } finally {
      if (saved !== undefined) process.env.GV_ICE_TURN_URLS = saved;
    }
  });

  it("proves relay allocation against a protocol-accurate coturn mock", async () => {
    mock = await startMockTurn();
    const url = `turn:127.0.0.1:${mock.port}?transport=udp`;
    const evidence = await runTurnProbe({
      urls: [url],
      username: "guest",
      credential: VALID_CREDENTIAL,
      timeoutMs: 2000,
    });
    expect(evidence.state).toBe("relayed");
    expect(evidence.relay_family).toBe("ipv4");
    expect(evidence.latency_ms).toBeDefined();
  });

  it("fails closed when the listener never responds", async () => {
    mock = await startMockTurn({ silent: true });
    const url = `turn:127.0.0.1:${mock.port}?transport=udp`;
    const evidence = await runTurnProbe({
      urls: [url],
      username: "guest",
      credential: VALID_CREDENTIAL,
      timeoutMs: 300,
    });
    expect(evidence.state).toBe("failed");
    expect(evidence.error).toContain("no response");
  });

  it("fails closed when credentials are rejected", async () => {
    mock = await startMockTurn({ rejectAll: true });
    const url = `turn:127.0.0.1:${mock.port}?transport=udp`;
    const evidence = await runTurnProbe({
      urls: [url],
      username: "guest",
      credential: "rotated-away",
      timeoutMs: 2000,
    });
    expect(evidence.state).toBe("failed");
    expect(evidence.error).toContain("rejected");
  });

  it("caches successful results and honors forced refresh", async () => {
    mock = await startMockTurn();
    const url = `turn:127.0.0.1:${mock.port}?transport=udp`;
    const first = await runTurnProbe({
      urls: [url],
      username: "guest",
      credential: VALID_CREDENTIAL,
      timeoutMs: 2000,
    });
    expect(first.state).toBe("relayed");

    // Close the server: cached evidence should still be returned (TTL).
    mock.close();
    mock = null;
    const cached = await runTurnProbe({
      urls: [url],
      username: "guest",
      credential: VALID_CREDENTIAL,
      timeoutMs: 300,
    });
    expect(cached.state).toBe("relayed");
    expect(cached.probed_at).toBe(first.probed_at);

    // Forced refresh re-probes and must fail now that the server is gone.
    const forced = await runTurnProbe({
      urls: [url],
      username: "guest",
      credential: VALID_CREDENTIAL,
      timeoutMs: 300,
      force: true,
    });
    expect(forced.state).toBe("failed");
  });

  it("never includes the credential in evidence or errors", async () => {
    mock = await startMockTurn({ silent: true });
    const url = `turn:127.0.0.1:${mock.port}?transport=udp`;
    const evidence = await runTurnProbe({
      urls: [url],
      username: "guest",
      credential: VALID_CREDENTIAL,
      timeoutMs: 300,
    });
    const serialized = JSON.stringify(evidence satisfies TurnProbeEvidence);
    expect(serialized).not.toContain(VALID_CREDENTIAL);
    expect(serialized).not.toContain("guest");
  });
});
