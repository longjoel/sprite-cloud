//! Browser-side ROM transfer client.
//! Upload uses WebRTC DataChannel; download uses HTTP proxy.
//!
//! Usage:
//!   const client = new RomTransferClient(file, transferCreds, serverId);
//!   client.onProgress = (sent, total) => { ... };
//!   const result = await client.upload();
//!   // or to download:
//!   await downloadRom(serverId, gameId, gameName);

export const ROM_TRANSFER_CHANNEL_LABEL = "rom-transfer-v1";
export const MAX_CONTROL_MESSAGE_BYTES = 8 * 1024;
const MAX_ERROR_REASON_BYTES = 1024;
const FALLBACK_CHUNK_SIZE = 16 * 1024; // Safe across WebRTC stacks without SCTP message interleaving
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

export function dataChannelChunkSize(maxMessageSize: number | undefined): number {
  if (
    typeof maxMessageSize === "number" &&
    Number.isFinite(maxMessageSize) &&
    maxMessageSize > 0
  ) {
    return Math.min(FALLBACK_CHUNK_SIZE, Math.floor(maxMessageSize));
  }
  return FALLBACK_CHUNK_SIZE;
}

// ── Types ──────────────────────────────────────────────────────────────

export interface TransferCredentials {
  transfer_id: string;
  capability_secret: string;
  command_id: string;
  expires_at: string;
  signaling: {
    server_id: string;
    transfer_id: string;
  };
}

export interface TransferResult {
  hash: string;
  size: number;
  game_id: string | null;
}

export type TransferPhase =
  | "signaling"
  | "connecting"
  | "authenticating"
  | "transferring"
  | "committing"
  | "done";

// ── Protocol messages (mirrors Rust TransferMessage) ───────────────────

interface AuthOkMessage {
  cmd: "auth_ok";
}

interface AuthErrorMessage {
  cmd: "auth_error";
  reason: string;
}

interface TransferOkMessage {
  cmd: "transfer_ok";
  hash: string;
  size: number;
  game_id?: string;
}

interface TransferErrorMessage {
  cmd: "transfer_error";
  reason: string;
}

export type ServerMessage =
  | AuthOkMessage
  | AuthErrorMessage
  | TransferOkMessage
  | TransferErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isBoundedReason(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_ERROR_REASON_BYTES;
}

/** Parse an untrusted text frame from the host using the strict v1 contract. */
export function parseRomTransferServerMessage(text: string): ServerMessage {
  if (new TextEncoder().encode(text).byteLength > MAX_CONTROL_MESSAGE_BYTES) {
    throw new Error("ROM transfer control message too large");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid ROM transfer control message");
  }
  if (!isRecord(value) || typeof value.cmd !== "string") {
    throw new Error("Invalid ROM transfer control message");
  }

  const valid = (() => {
    switch (value.cmd) {
      case "auth_ok":
        return hasExactKeys(value, ["cmd"]);
      case "auth_error":
      case "transfer_error":
        return hasExactKeys(value, ["cmd", "reason"]) && isBoundedReason(value.reason);
      case "transfer_ok":
        return hasExactKeys(value, ["cmd", "hash", "size"], ["game_id"]) &&
          isSha256(value.hash) &&
          typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0 &&
          (value.game_id === undefined || value.game_id === null ||
            (typeof value.game_id === "string" && value.game_id.length > 0 && value.game_id.length <= 256));
      default:
        return false;
    }
  })();

  if (!valid) throw new Error("Invalid ROM transfer control message");
  return value as unknown as ServerMessage;
}

// ── Helpers ────────────────────────────────────────────────────────────

function csrfHeaders(): Record<string, string> {
  let token = "";
  if (typeof document !== "undefined") {
    token =
      document.cookie
        .split(";")
        .map((p) => p.trim())
        .find((p) => p.startsWith("sc_csrf_token="))
        ?.split("=")
        .slice(1)
        .join("=") ?? "";
  }
  return {
    "Content-Type": "application/json",
    "x-csrf-token": decodeURIComponent(token),
  };
}

async function fetchIceConfig(): Promise<RTCConfiguration> {
  const resp = await fetch("/api/ice-config");
  if (!resp.ok) throw new Error(`ICE config fetch failed: ${resp.status}`);
  const data = (await resp.json()) as {
    iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  };
  const servers: RTCIceServer[] = (data.iceServers ?? []).map((s) => ({
    urls: s.urls,
    username: s.username,
    credential: s.credential,
  }));
  return { iceServers: servers };
}

// ── Client ─────────────────────────────────────────────────────────────

export class RomTransferClient {
  private file: File;
  private creds: TransferCredentials;
  private serverId: string;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private abortController: AbortController;

  public onProgress?: (sent: number, total: number) => void;
  public onPhase?: (phase: TransferPhase) => void;

  constructor(
    file: File,
    creds: TransferCredentials,
    serverId: string,
  ) {
    this.file = file;
    this.creds = creds;
    this.serverId = serverId;
    this.abortController = new AbortController();
  }

  /** Cancel an in-progress upload. */
  cancel(): void {
    this.abortController.abort();
    this.pc?.close();
  }

  /** Run the full upload flow. Returns transfer result or throws. */
  async upload(): Promise<TransferResult> {
    const signal = this.abortController.signal;

    try {
      // 1. Create peer connection + data channel
      this.setPhase("signaling");
      const iceConfig = await fetchIceConfig();
      this.pc = new RTCPeerConnection(iceConfig);
      this.dc = this.pc.createDataChannel(ROM_TRANSFER_CHANNEL_LABEL, {
        ordered: true,
      });

      // 2. Create SDP offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete (candidates embedded in SDP)
      await this.waitForIceGathering();

      // 3. Send SDP offer to signaling endpoint
      const sdp = this.pc.localDescription?.sdp;
      if (!sdp) throw new Error("No local SDP available");

      const offerResp = await fetch(
        `/api/servers/${encodeURIComponent(this.serverId)}/rom-transfers/${encodeURIComponent(this.creds.transfer_id)}/offer`,
        {
          method: "POST",
          headers: csrfHeaders(),
          body: JSON.stringify({
            sdp,
            capability_secret: this.creds.capability_secret,
          }),
          signal,
        },
      );
      if (!offerResp.ok) {
        const err = await offerResp.json() as { error?: string };
        throw new Error(err.error ?? `Signaling failed: HTTP ${offerResp.status}`);
      }

      // 4. Poll for SDP answer
      this.setPhase("connecting");
      const answer = await this.pollForAnswer(signal);
      await this.pc.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: answer }),
      );

      // 5. Wait for data channel to open
      await this.waitForDcOpen(signal);

      // 6. Authenticate
      this.setPhase("authenticating");
      this.sendJson({ cmd: "auth", capability_secret: this.creds.capability_secret });
      const authResponse = await this.waitForMessage(signal);
      if (authResponse.cmd === "auth_error") {
        throw new Error(`Auth rejected: ${authResponse.reason}`);
      }
      if (authResponse.cmd !== "auth_ok") {
        throw new Error(`Unexpected auth response: ${authResponse.cmd}`);
      }

      // 7. Send file chunks
      this.setPhase("transferring");
      await this.sendFileChunks(signal);

      // 8. Signal completion and wait for commit result
      this.setPhase("committing");
      this.sendJson({ cmd: "transfer_complete" });
      const completeResponse = await this.waitForMessage(signal);
      if (completeResponse.cmd === "transfer_error") {
        throw new Error(`Transfer failed: ${completeResponse.reason}`);
      }
      if (completeResponse.cmd !== "transfer_ok") {
        throw new Error(`Unexpected completion response: ${completeResponse.cmd}`);
      }

      this.setPhase("done");
      return {
        hash: (completeResponse as TransferOkMessage).hash,
        size: (completeResponse as TransferOkMessage).size,
        game_id: (completeResponse as TransferOkMessage).game_id ?? null,
      };
    } finally {
      this.pc?.close();
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private setPhase(phase: TransferPhase): void {
    this.onPhase?.(phase);
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (!this.dc || this.dc.readyState !== "open") {
      throw new Error("Data channel not open");
    }
    this.dc.send(JSON.stringify(obj));
  }

  private waitForIceGathering(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.pc) return reject(new Error("No PC"));
      if (this.pc.iceGatheringState === "complete") return resolve();

      const timeout = setTimeout(() => {
        reject(new Error("ICE gathering timed out"));
      }, 15_000);

      this.pc.addEventListener("icegatheringstatechange", () => {
        if (this.pc?.iceGatheringState === "complete") {
          clearTimeout(timeout);
          resolve();
        }
      }, { once: false });
    });
  }

  private async pollForAnswer(signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error("Cancelled");

      const resp = await fetch(
        `/api/commands/${encodeURIComponent(this.creds.command_id)}/result`,
        { signal },
      );
      if (!resp.ok) {
        await this.sleep(POLL_INTERVAL_MS);
        continue;
      }

      const data = (await resp.json()) as {
        status?: string;
        result?: unknown;
        sdp_answer?: string | null;
        error?: string | null;
      };

      if (data.error) {
        throw new Error(`Server error: ${data.error}`);
      }
      if (data.sdp_answer) {
        return data.sdp_answer;
      }
      // If command failed without SDP answer, that's an error
      if (data.status === "failed") {
        throw new Error("Transfer command failed on server");
      }

      await this.sleep(POLL_INTERVAL_MS);
    }
    throw new Error("Timed out waiting for SDP answer");
  }

  private waitForDcOpen(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.dc) return reject(new Error("No DC"));
      if (this.dc.readyState === "open") return resolve();

      const timeout = setTimeout(() => {
        reject(new Error("Data channel open timed out"));
      }, 15_000);

      const onOpen = () => {
        clearTimeout(timeout);
        resolve();
      };
      const onAbort = () => {
        clearTimeout(timeout);
        reject(new Error("Cancelled"));
      };

      this.dc.addEventListener("open", onOpen, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private waitForMessage(signal: AbortSignal): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      if (!this.dc) return reject(new Error("No DC"));

      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for server response"));
      }, 30_000);

      const onMessage = (event: MessageEvent<string>) => {
        clearTimeout(timeout);
        try {
          resolve(parseRomTransferServerMessage(event.data));
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Invalid ROM transfer control message"));
        }
      };
      const onAbort = () => {
        clearTimeout(timeout);
        reject(new Error("Cancelled"));
      };

      this.dc.addEventListener("message", onMessage, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async sendFileChunks(signal: AbortSignal): Promise<void> {
    const total = this.file.size;
    const chunkSize = dataChannelChunkSize(this.pc?.sctp?.maxMessageSize);
    let offset = 0;

    while (offset < total) {
      if (signal.aborted) throw new Error("Cancelled");

      const end = Math.min(offset + chunkSize, total);
      const chunk = this.file.slice(offset, end);
      const buffer = await chunk.arrayBuffer();

      // Wait if the data channel buffer is full (backpressure)
      while (
        this.dc &&
        this.dc.readyState === "open" &&
        this.dc.bufferedAmount > chunkSize * 2
      ) {
        await this.sleep(50);
      }

      if (!this.dc || this.dc.readyState !== "open") {
        throw new Error("Data channel closed during transfer");
      }

      this.dc.send(new Uint8Array(buffer));
      offset = end;
      this.onProgress?.(offset, total);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ── Download ────────────────────────────────────────────────────────────

const DOWNLOAD_POLL_INTERVAL_MS = 500;
const DOWNLOAD_POLL_TIMEOUT_MS = 120_000;

/**
 * Download a ROM from the server. Simple HTTP flow:
 *   1. Queue a rom_download command on sc-web
 *   2. Poll for the command result (contains download URL)
 *   3. Navigate browser to the URL → instant file download
 */
export async function downloadRom(
  serverId: string,
  gameId: string,
  _gameName: string,
): Promise<{ sha256: string; size: number }> {
  const headers = csrfHeaders();

  // Queue the download command
  const queueRes = await fetch(
    `/api/servers/${encodeURIComponent(serverId)}/rom-downloads`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ game_id: gameId }),
    },
  );

  if (!queueRes.ok) {
    const err = await queueRes.json().catch(() => ({}));
    throw new Error(err.error ?? "Failed to queue download");
  }

  const { command_id } = await queueRes.json();
  if (!command_id) throw new Error("No command ID returned");

  // Poll for the result (contains download URL)
  const pollStart = Date.now();
  while (Date.now() - pollStart < DOWNLOAD_POLL_TIMEOUT_MS) {
    const pollRes = await fetch(
      `/api/servers/${encodeURIComponent(serverId)}/rom-downloads?command_id=${encodeURIComponent(command_id)}`,
      { headers },
    );

    if (pollRes.ok) {
      const data = await pollRes.json();
      if (data.url) {
        // Navigate to the download URL — triggers browser download
        window.location.href = data.url;
        return { sha256: data.sha256 ?? "", size: data.size ?? 0 };
      }
    }

    await new Promise((r) => setTimeout(r, DOWNLOAD_POLL_INTERVAL_MS));
  }

  throw new Error("Download timed out — server did not prepare the file");
}
