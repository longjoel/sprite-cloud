// ── TURN allocation probe ───────────────────────────────────────────────
//
// Proves the production TURN path end-to-end at the protocol level instead
// of trusting configured env values:
//
//   unconfigured      → no TURN URL configured
//   configured        → URL present, probe not yet run
//   reachable         → the listener answered a STUN/TURN request
//   credential-issued → the server challenged with realm+nonce (long-term
//                       credential mechanism active)
//   relayed           → an Allocate succeeded and returned RELAYED-ADDRESS
//   failed            → socket error, timeout, or rejected credentials
//
// Implementation is a minimal RFC 5389/5766 client over UDP. Only the first
// configured TURN URL is probed; production uses a single relay.
//
// Secrets discipline: this module never logs or returns the credential, and
// error strings are scrubbed of URL userinfo.

import dgram from "dgram";
import crypto from "crypto";

export type TurnProbeState =
  | "unconfigured"
  | "configured"
  | "reachable"
  | "credential-issued"
  | "relayed"
  | "failed";

export interface TurnProbeEvidence {
  state: TurnProbeState;
  probed_at: string;
  latency_ms?: number;
  relay_family?: "ipv4" | "ipv6";
  /** Sanitized, human-readable failure reason. Never contains credentials. */
  error?: string;
}

interface TurnEndpoint {
  host: string;
  port: number;
  transport: "udp" | "tcp";
}

// STUN message type: Allocate request (RFC 5766 §6.1)
const TYPE_ALLOCATE = 0x0003;
const TYPE_ALLOCATE_SUCCESS = 0x0103;
const TYPE_ALLOCATE_ERROR = 0x0113;
const MAGIC_COOKIE = 0x2112a442;

// Attribute types (RFC 5389 §18.2, RFC 5766 §14)
const ATTR_MESSAGE_INTEGRITY = 0x0008;
const ATTR_ERROR_CODE = 0x0009;
const ATTR_NONCE = 0x0015;
const ATTR_REALM = 0x0014;
const ATTR_REQUESTED_TRANSPORT = 0x0019;
const ATTR_USERNAME = 0x0006;
const ATTR_XOR_RELAYED_ADDRESS = 0x0016;

const PROTOCOL_UDP = 17;

export function parseTurnUrl(raw: string): TurnEndpoint {
  // Accept turn:host:port?transport=udp and turn://host:port/... forms.
  const withoutScheme = raw.replace(/^turn:\/\//, "").replace(/^turn:/, "");
  const [authorityPart] = withoutScheme.split("?");
  const [host, portRaw] = authorityPart.split(":");
  const transport = /transport=tcp/.test(raw) ? "tcp" : "udp";
  return {
    host: host || "localhost",
    port: portRaw ? Number(portRaw) : 3478,
    transport,
  };
}

function pad4(buf: Buffer): Buffer {
  const rem = buf.length % 4;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}

function buildStunHeader(type: number, length: number, transactionId: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return header;
}

function buildAllocateRequest(opts: {
  transactionId: Buffer;
  username?: string;
  realm?: string;
  nonce?: string;
  credential?: string;
}): Buffer {
  const { transactionId, username, realm, nonce, credential } = opts;

  const attrs: Buffer[] = [];

  // REQUESTED-TRANSPORT = UDP (4 bytes: protocol, 3 reserved zero bytes)
  const transport = Buffer.alloc(4);
  transport.writeUInt8(PROTOCOL_UDP, 0);
  attrs.push(attr(ATTR_REQUESTED_TRANSPORT, transport));

  if (username) {
    attrs.push(attr(ATTR_USERNAME, Buffer.from(username, "utf8")));
  }
  if (realm) {
    attrs.push(attr(ATTR_REALM, Buffer.from(realm, "utf8")));
  }
  if (nonce) {
    attrs.push(attr(ATTR_NONCE, Buffer.from(nonce, "utf8")));
  }

  // MESSAGE-INTEGRITY must be the last attribute; the header length field
  // includes it, but the HMAC input excludes it (RFC 5389 §15.4).
  const bodyWithoutIntegrity = Buffer.concat(
    attrs.map((a) => (a.length % 4 === 0 ? a : pad4(a))),
  );

  let message: Buffer;
  if (credential && realm && username) {
    const integrityAttr = Buffer.alloc(24); // type(2) + len(2) + hmac(20)
    integrityAttr.writeUInt16BE(ATTR_MESSAGE_INTEGRITY, 0);
    integrityAttr.writeUInt16BE(20, 2);
    const length = bodyWithoutIntegrity.length + integrityAttr.length;
    message = Buffer.concat([buildStunHeader(TYPE_ALLOCATE, length, transactionId), bodyWithoutIntegrity]);
    const key = longTermKey(username, realm, credential);
    const hmac = crypto.createHmac("sha1", key).update(message).digest();
    integrityAttr.fill(hmac, 4);
    message = Buffer.concat([message, integrityAttr]);
  } else {
    const length = bodyWithoutIntegrity.length;
    message = Buffer.concat([buildStunHeader(TYPE_ALLOCATE, length, transactionId), bodyWithoutIntegrity]);
  }

  return message;
}

function attr(type: number, value: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  return Buffer.concat([header, pad4(value)]);
}

// Long-term credential key: MD5(username ":" realm ":" password) (RFC 5389 §15.4)
function longTermKey(username: string, realm: string, password: string): Buffer {
  return crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest();
}

interface ParsedStunMessage {
  type: number;
  transactionId: Buffer;
  attributes: Map<number, Buffer>;
}

function parseStunMessage(buf: Buffer): ParsedStunMessage | null {
  if (buf.length < 20) return null;
  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  const cookie = buf.readUInt32BE(4);
  if (cookie !== MAGIC_COOKIE) return null;
  const transactionId = buf.subarray(8, 20);
  const attributes = new Map<number, Buffer>();
  let offset = 20;
  const end = Math.min(buf.length, 20 + length);
  while (offset + 4 <= end) {
    const attrType = buf.readUInt16BE(offset);
    const attrLen = buf.readUInt16BE(offset + 2);
    const value = buf.subarray(offset + 4, offset + 4 + attrLen);
    attributes.set(attrType, value);
    offset += 4 + attrLen + (attrLen % 4 === 0 ? 0 : 4 - (attrLen % 4));
  }
  return { type, transactionId, attributes };
}

function errorCodeFrom(attrs: Map<number, Buffer>): number | null {
  const raw = attrs.get(ATTR_ERROR_CODE);
  if (!raw || raw.length < 4) return null;
  // RFC 5389 §15.6: class = high 3 bits of byte 2 (hundreds digit),
  // number = byte 3 (tens+units). Verified against coturn 4.6.1:
  // 401 → [0x00, 0x00, 0x04, 0x01].
  return ((raw[2] & 0x07) * 100) + raw[3];
}

function relayFamilyFrom(attrs: Map<number, Buffer>): "ipv4" | "ipv6" | undefined {
  const raw = attrs.get(ATTR_XOR_RELAYED_ADDRESS);
  if (!raw || raw.length < 4) return undefined;
  // family byte: 0x01 = IPv4, 0x02 = IPv6
  return raw[1] === 0x02 ? "ipv6" : "ipv4";
}

export function scrubError(message: string): string {
  // Remove userinfo (user:pass@) from any URL-like text before surfacing it.
  return message.replace(/\/\/[^/@\s]+@/g, "//<redacted>@");
}

async function probeEndpoint(endpoint: TurnEndpoint, username: string, credential: string, timeoutMs: number): Promise<TurnProbeEvidence> {
  if (endpoint.transport !== "udp") {
    return {
      state: "failed",
      probed_at: new Date().toISOString(),
      error: `transport ${endpoint.transport} not supported by probe (UDP only)`,
    };
  }

  const started = Date.now();
  const socket = dgram.createSocket("udp4");
  // The first request has no credentials; the 401 challenge is answered with
  // a *fresh* transaction ID (RFC 5389 §10). Track which TID responses must
  // match so the retry isn't mistaken for a stale echo.
  let currentTransactionId = crypto.randomBytes(12);
  let sentCredentials = false;

  return new Promise<TurnProbeEvidence>((resolve) => {
    let settled = false;
    const finish = (evidence: TurnProbeEvidence) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(evidence);
    };

    const timer = setTimeout(() => {
      finish({
        state: "failed",
        probed_at: new Date().toISOString(),
        latency_ms: Date.now() - started,
        error: `no response from ${endpoint.host}:${endpoint.port} within ${timeoutMs}ms`,
      });
    }, timeoutMs);

    socket.on("error", (err) => {
      finish({
        state: "failed",
        probed_at: new Date().toISOString(),
        latency_ms: Date.now() - started,
        error: scrubError(err.message),
      });
    });

    socket.on("message", (msg) => {
      const parsed = parseStunMessage(msg);
      if (!parsed || !parsed.transactionId.equals(currentTransactionId)) return;

      if (parsed.type === TYPE_ALLOCATE_SUCCESS) {
        finish({
          state: "relayed",
          probed_at: new Date().toISOString(),
          latency_ms: Date.now() - started,
          relay_family: relayFamilyFrom(parsed.attributes),
        });
        return;
      }

      if (parsed.type === TYPE_ALLOCATE_ERROR) {
        const code = errorCodeFrom(parsed.attributes);
        if (code === 401) {
          // Server challenged us: listener is up and the long-term credential
          // mechanism is active. If we already sent credentials, this means
          // they were rejected.
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
            // First round: re-send with long-term credentials under a fresh
            // transaction ID.
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

      // Unexpected type (e.g. a Binding response) — treat as reachable only.
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
          error: scrubError(err.message),
        });
      }
    });
  });
}

// ── Cached runner for /api/health ──────────────────────────────────────

interface ProbeCacheEntry {
  evidence: TurnProbeEvidence;
  expiresAt: number;
}

let probeCache: ProbeCacheEntry | null = null;

// Successful allocations are cached longer than failures so a flapping relay
// is detected promptly: failures re-probe every FAILURE_TTL_MS.
const SUCCESS_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;

export async function runTurnProbe(opts?: {
  urls?: string[];
  username?: string;
  credential?: string;
  timeoutMs?: number;
  force?: boolean;
}): Promise<TurnProbeEvidence> {
  const urls = opts?.urls ?? process.env.GV_ICE_TURN_URLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const username = opts?.username ?? process.env.GV_ICE_TURN_USERNAME ?? "";
  const credential = opts?.credential ?? process.env.GV_ICE_TURN_CREDENTIAL ?? "";
  const timeoutMs = opts?.timeoutMs ?? 3_000;

  if (urls.length === 0) {
    return { state: "unconfigured", probed_at: new Date().toISOString() };
  }

  const now = Date.now();
  if (!opts?.force && probeCache && probeCache.expiresAt > now) {
    return probeCache.evidence;
  }

  const evidence = await probeEndpoint(parseTurnUrl(urls[0]), username, credential, timeoutMs);
  probeCache = {
    evidence,
    expiresAt: now + (evidence.state === "relayed" ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
  };
  return evidence;
}

// Test seam: clear the cached probe result.
export function resetTurnProbeCache(): void {
  probeCache = null;
}
