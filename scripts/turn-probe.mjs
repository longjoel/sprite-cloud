#!/usr/bin/env node
// ── TURN relay operator probe ──────────────────────────────────────────
//
// Standalone, zero-dependency operator tool that forces a real TURN
// Allocate (RFC 5766) against a production relay from wherever it is run.
// It proves the four states #660 cares about and prints sanitized, non-secret
// route/stage evidence as JSON:
//
//   unconfigured      → no TURN URL supplied
//   reachable         → the listener answered
//   credential-issued → server challenged with realm+nonce (long-term creds)
//   relayed           → allocation granted with a RELAYED-ADDRESS
//   failed            → socket error, timeout, or rejected credentials
//
// Usage:
//   GV_ICE_TURN_URLS=turn:host:3478 GV_ICE_TURN_USERNAME=guest \
//   GV_ICE_TURN_CREDENTIAL=secret node scripts/turn-probe.mjs
//
// or with explicit arguments:
//   node scripts/turn-probe.mjs turn:host:3478 guest secret
//
// The credential is read from the environment or argv and is NEVER printed.
// Output contains only non-secret evidence (state, latency, relay family).
//
// This file intentionally re-implements the minimal protocol client from
// sc-web/lib/turn-probe.ts so operators do not need the web toolchain.

import dgram from "node:dgram";
import crypto from "node:crypto";

const TYPE_ALLOCATE = 0x0003;
const TYPE_ALLOCATE_SUCCESS = 0x0103;
const TYPE_ALLOCATE_ERROR = 0x0113;
const MAGIC_COOKIE = 0x2112a442;
const ATTR_MESSAGE_INTEGRITY = 0x0008;
const ATTR_ERROR_CODE = 0x0009;
const ATTR_NONCE = 0x0015;
const ATTR_REALM = 0x0014;
const ATTR_REQUESTED_TRANSPORT = 0x0019;
const ATTR_USERNAME = 0x0006;
const ATTR_XOR_RELAYED_ADDRESS = 0x0016;
const PROTOCOL_UDP = 17;

function parseTurnUrl(raw) {
  const withoutScheme = raw.replace(/^turn:\/\//, "").replace(/^turn:/, "");
  const [authorityPart] = withoutScheme.split("?");
  const [host, portRaw] = authorityPart.split(":");
  return { host: host || "localhost", port: portRaw ? Number(portRaw) : 3478 };
}

function pad4(buf) {
  const rem = buf.length % 4;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}

function header(type, length, transactionId) {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(length, 2);
  h.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(h, 8);
  return h;
}

function attr(type, value) {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(value.length, 2);
  return Buffer.concat([h, pad4(value)]);
}

function longTermKey(username, realm, password) {
  return crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest();
}

function buildAllocateRequest({ transactionId, username, realm, nonce, credential }) {
  const attrs = [];
  const transport = Buffer.alloc(4);
  transport.writeUInt8(PROTOCOL_UDP, 0);
  attrs.push(attr(ATTR_REQUESTED_TRANSPORT, transport));
  if (username) attrs.push(attr(ATTR_USERNAME, Buffer.from(username, "utf8")));
  if (realm) attrs.push(attr(ATTR_REALM, Buffer.from(realm, "utf8")));
  if (nonce) attrs.push(attr(ATTR_NONCE, Buffer.from(nonce, "utf8")));

  const body = Buffer.concat(attrs);
  if (credential && realm && username) {
    const integrityAttr = Buffer.alloc(24);
    integrityAttr.writeUInt16BE(ATTR_MESSAGE_INTEGRITY, 0);
    integrityAttr.writeUInt16BE(20, 2);
    const message = Buffer.concat([header(TYPE_ALLOCATE, body.length + 24, transactionId), body]);
    const hmac = crypto.createHmac("sha1", longTermKey(username, realm, credential)).update(message).digest();
    integrityAttr.fill(hmac, 4);
    return Buffer.concat([message, integrityAttr]);
  }
  return Buffer.concat([header(TYPE_ALLOCATE, body.length, transactionId), body]);
}

function parseStun(buf) {
  if (buf.length < 20) return null;
  if (buf.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  const transactionId = buf.subarray(8, 20);
  const attributes = new Map();
  let offset = 20;
  const end = Math.min(buf.length, 20 + length);
  while (offset + 4 <= end) {
    const t = buf.readUInt16BE(offset);
    const len = buf.readUInt16BE(offset + 2);
    attributes.set(t, buf.subarray(offset + 4, offset + 4 + len));
    offset += 4 + len + (len % 4 === 0 ? 0 : 4 - (len % 4));
  }
  return { type, transactionId, attributes };
}

function errorCode(attrs) {
  const raw = attrs.get(ATTR_ERROR_CODE);
  if (!raw || raw.length < 4) return null;
  return (raw[2] & 0x07) * 100 + raw[3];
}

function relayFamily(attrs) {
  const raw = attrs.get(ATTR_XOR_RELAYED_ADDRESS);
  if (!raw || raw.length < 4) return undefined;
  return raw[1] === 0x02 ? "ipv6" : "ipv4";
}

function scrub(message) {
  return message.replace(/\/\/[^/@\s]+@/g, "//<redacted>@");
}

async function probe(url, username, credential, timeoutMs = 3000) {
  const endpoint = parseTurnUrl(url);
  const started = Date.now();
  const socket = dgram.createSocket("udp4");
  let currentTransactionId = crypto.randomBytes(12);
  let sentCredentials = false;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (evidence) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(evidence);
    };

    const timer = setTimeout(() => finish({
      state: "failed",
      probed_at: new Date().toISOString(),
      latency_ms: Date.now() - started,
      error: `no response from ${endpoint.host}:${endpoint.port} within ${timeoutMs}ms`,
    }), timeoutMs);

    socket.on("error", (err) => finish({
      state: "failed",
      probed_at: new Date().toISOString(),
      latency_ms: Date.now() - started,
      error: scrub(err.message),
    }));

    socket.on("message", (msg) => {
      const parsed = parseStun(msg);
      if (!parsed || !parsed.transactionId.equals(currentTransactionId)) return;

      if (parsed.type === TYPE_ALLOCATE_SUCCESS) {
        finish({
          state: "relayed",
          probed_at: new Date().toISOString(),
          latency_ms: Date.now() - started,
          relay_family: relayFamily(parsed.attributes),
        });
        return;
      }

      if (parsed.type === TYPE_ALLOCATE_ERROR) {
        const code = errorCode(parsed.attributes);
        if (code === 401) {
          const realm = parsed.attributes.get(ATTR_REALM)?.toString("utf8");
          const nonce = parsed.attributes.get(ATTR_NONCE)?.toString("utf8");
          if (realm && nonce) {
            if (sentCredentials) {
              finish({
                state: "failed",
                probed_at: new Date().toISOString(),
                latency_ms: Date.now() - started,
                error: "TURN server rejected the configured credentials (401)",
              });
              return;
            }
            sentCredentials = true;
            currentTransactionId = crypto.randomBytes(12);
            const retry = buildAllocateRequest({
              transactionId: currentTransactionId,
              username,
              realm,
              nonce,
              credential,
            });
            socket.send(retry, endpoint.port, endpoint.host);
            return;
          }
          finish({
            state: "credential-issued",
            probed_at: new Date().toISOString(),
            latency_ms: Date.now() - started,
          });
          return;
        }
        finish({
          state: "failed",
          probed_at: new Date().toISOString(),
          latency_ms: Date.now() - started,
          error: `TURN server returned error ${code}`,
        });
        return;
      }

      finish({
        state: "reachable",
        probed_at: new Date().toISOString(),
        latency_ms: Date.now() - started,
      });
    });

    const first = buildAllocateRequest({ transactionId: currentTransactionId });
    socket.send(first, endpoint.port, endpoint.host, (err) => {
      if (err) {
        finish({
          state: "failed",
          probed_at: new Date().toISOString(),
          latency_ms: Date.now() - started,
          error: scrub(err.message),
        });
      }
    });
  });
}

async function main() {
  const [argUrl, argUser, argCred] = process.argv.slice(2);
  const url = argUrl || process.env.GV_ICE_TURN_URLS?.split(",")[0]?.trim();
  const username = argUser || process.env.GV_ICE_TURN_USERNAME || "";
  const credential = argCred || process.env.GV_ICE_TURN_CREDENTIAL || "";

  if (!url) {
    console.error("usage: GV_ICE_TURN_URLS=... GV_ICE_TURN_USERNAME=... GV_ICE_TURN_CREDENTIAL=... node scripts/turn-probe.mjs");
    process.exit(2);
  }

  const evidence = await probe(url, username, credential);
  const safeUrl = url.replace(/\/\/[^/@\s]+@/g, "//<redacted>@");
  console.log(JSON.stringify({ url: safeUrl, ...evidence }, null, 2));
  process.exit(evidence.state === "relayed" ? 0 : 1);
}

main().catch((err) => {
  console.error(scrub(String(err?.stack || err)));
  process.exit(1);
});
