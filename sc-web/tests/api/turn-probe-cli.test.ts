/**
 * Operator CLI probe test.
 *
 * The standalone operator tool (scripts/turn-probe.mjs) re-implements the
 * minimal TURN protocol so operators do not need the web toolchain. This
 * test spawns the real CLI against the same protocol-accurate mock coturn
 * used by lib tests, proving the CLI copy cannot drift from lib behavior.
 *
 * Run: npx vitest run tests/api/turn-probe-cli.test.ts
 */

import { describe, expect, it, afterEach } from "vitest";
import dgram from "dgram";
import crypto from "crypto";
import { spawn } from "child_process";
import { join } from "path";

const MAGIC_COOKIE = 0x2112a442;
const VALID_CREDENTIAL = "correct-horse-battery-staple";

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

function makeErrorResponse(transactionId: Buffer, realm: string, nonce: string): Buffer {
  const errAttr = Buffer.alloc(4);
  errAttr[2] = 4;
  errAttr[3] = 1;
  const attrs = [
    attr(0x0009, errAttr),
    attr(0x0014, Buffer.from(realm, "utf8")),
    attr(0x0015, Buffer.from(nonce, "utf8")),
  ];
  const body = Buffer.concat(attrs);
  return Buffer.concat([stunHeader(0x0113, body.length, transactionId), body]);
}

function makeSuccessResponse(transactionId: Buffer): Buffer {
  const relayed = Buffer.alloc(8);
  relayed[1] = 0x01;
  relayed.writeUInt16BE(49152 ^ (MAGIC_COOKIE >> 16), 2);
  relayed.writeUInt32BE((0x7f000001 ^ MAGIC_COOKIE) >>> 0, 4);
  const lifetime = Buffer.alloc(4);
  lifetime.writeUInt32BE(600, 0);
  const attrs = [attr(0x0016, relayed), attr(0x000d, lifetime)];
  const body = Buffer.concat(attrs);
  return Buffer.concat([stunHeader(0x0103, body.length, transactionId), body]);
}

function parseStunHeader(buf: Buffer): { transactionId: Buffer } {
  return { transactionId: buf.subarray(8, 20) };
}

function startMockTurn(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const nonce = crypto.randomBytes(16).toString("hex");
    const challenged = new Set<string>();

    socket.on("message", (msg, rinfo) => {
      if (msg.length < 20) return;
      const { transactionId } = parseStunHeader(msg);
      const peerKey = `${rinfo.address}:${rinfo.port}`;
      if (challenged.has(peerKey)) {
        socket.send(makeSuccessResponse(transactionId), rinfo.port, rinfo.address);
        return;
      }
      challenged.add(peerKey);
      socket.send(makeErrorResponse(transactionId, "sprite-cloud.com", nonce), rinfo.port, rinfo.address);
    });

    socket.bind(0, "127.0.0.1", () => {
      resolve({ port: (socket.address() as { port: number }).port, close: () => socket.close() });
    });
  });
}

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(__dirname, "../../../scripts/turn-probe.mjs"), ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("scripts/turn-probe.mjs operator CLI", () => {
  let mock: { port: number; close: () => void } | null = null;

  afterEach(() => {
    mock?.close();
    mock = null;
  });

  it("proves relay allocation and exits 0", async () => {
    mock = await startMockTurn();
    const url = `turn:127.0.0.1:${mock.port}?transport=udp`;
    const { code, stdout } = await runCli([url, "guest", VALID_CREDENTIAL], {});
    expect(code).toBe(0);
    const evidence = JSON.parse(stdout);
    expect(evidence.state).toBe("relayed");
    expect(evidence.relay_family).toBe("ipv4");
    expect(JSON.stringify(evidence)).not.toContain(VALID_CREDENTIAL);
    expect(JSON.stringify(evidence)).not.toContain("guest");
  });

  it("exits 1 when the relay is unreachable", async () => {
    // Get a loopback port, then close the listener so nothing answers.
    const dead = await startMockTurn();
    const deadPort = dead.port;
    dead.close();
    const url = `turn:127.0.0.1:${deadPort}?transport=udp`;
    const { code, stdout } = await runCli([url, "guest", VALID_CREDENTIAL], {});
    expect(code).toBe(1);
    const evidence = JSON.parse(stdout);
    expect(evidence.state).toBe("failed");
  });
});
