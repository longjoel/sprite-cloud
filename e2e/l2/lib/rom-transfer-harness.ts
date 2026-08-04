/**
 * ROM transfer E2E harness (#631).
 *
 * Upload uses WebRTC DataChannel; download uses HTTP polling.
 * All API calls inside page.evaluate() use a CSRF token extracted
 * from browser cookies at call time.
 */
import type { Page } from "@playwright/test";

// ── Types ──────────────────────────────────────────────────────────────

export interface TransferCredentials {
  transfer_id: string;
  capability_secret: string;
  command_id: string;
  expires_at: string;
  signaling: { server_id: string; transfer_id: string };
}

export interface UploadResult {
  hash: string;
  size: number;
  game_id: string | null;
}

export interface DownloadResult {
  sha256: string;
  size: number;
  bytesB64: string;
}

// ── Create transfer credentials ────────────────────────────────────────

export async function createTransferCreds(
  page: Page,
  serverId: string,
  basename: string,
  declaredSize: number,
): Promise<TransferCredentials> {
  return page.evaluate(
    async ({ serverId, basename, declaredSize }) => {
      const csrf = () => { const c = document.cookie.split(";").map((p:string) => p.trim()).find((p:string) => p.startsWith("sc_csrf_token="))?.split("=").slice(1).join("="); return c ? decodeURIComponent(c) : ""; };
      const resp = await fetch(
        `/api/servers/${encodeURIComponent(serverId)}/rom-transfers`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrf(),
          },
          body: JSON.stringify({ basename, declared_size: declaredSize }),
        },
      );
      if (!resp.ok) {
        const err = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Transfer auth failed (HTTP ${resp.status})`);
      }
      return (await resp.json()) as TransferCredentials;
    },
    { serverId, basename, declaredSize },
  );
}

// ── Upload via WebRTC DataChannel ──────────────────────────────────────

export async function uploadRomInBrowser(
  page: Page,
  serverId: string,
  creds: TransferCredentials,
  fileBytesB64: string,
  fileName: string,
): Promise<UploadResult> {
  return page.evaluate(
    async ({ serverId, creds, fileBytesB64, fileName }) => {
      // Decode file bytes
      const binaryStr = atob(fileBytesB64);
      const fileBytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) fileBytes[i] = binaryStr.charCodeAt(i);

      const csrf = () => { const c = document.cookie.split(";").map((p:string) => p.trim()).find((p:string) => p.startsWith("sc_csrf_token="))?.split("=").slice(1).join("="); return c ? decodeURIComponent(c) : ""; };

      // 1. ICE config
      const iceResp = await fetch("/api/ice-config");
      if (!iceResp.ok) throw new Error("ICE config fetch failed");
      const iceCfg = (await iceResp.json()) as { iceServers?: RTCIceServer[] };

      // 2. Create peer connection + data channel
      const pc = new RTCPeerConnection({ iceServers: iceCfg.iceServers ?? [] });
      const dc = pc.createDataChannel("rom-transfer-v1", { ordered: true });

      // 3. Create SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering (loopback — proceed on timeout)
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const t = setTimeout(() => resolve(), 30_000);
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
        }, { once: true });
      });

      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("No local SDP");

      // 4. Send offer to signaling
      const offerResp = await fetch(
        `/api/servers/${encodeURIComponent(serverId)}/rom-transfers/${encodeURIComponent(creds.transfer_id)}/offer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-csrf-token": csrf() },
          body: JSON.stringify({ sdp, capability_secret: creds.capability_secret }),
        },
      );
      if (!offerResp.ok) {
        const err = (await offerResp.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Offer failed: HTTP ${offerResp.status}`);
      }

      // 5. Poll for SDP answer
      let answerSdp: string | null = null;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const pollResp = await fetch(
          `/api/commands/${encodeURIComponent(creds.command_id)}/result`,
        );
        if (pollResp.ok) {
          const d = (await pollResp.json()) as { status?: string; sdp_answer?: string | null; error?: string | null };
          if (d.error) throw new Error(`Server error: ${d.error}`);
          if (d.sdp_answer) { answerSdp = d.sdp_answer; break; }
          if (d.status === "failed") throw new Error("Transfer command failed");
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!answerSdp) throw new Error("Timed out waiting for SDP answer");
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: answerSdp }));

      // 6. Wait for data channel open
      await new Promise<void>((resolve, reject) => {
        if (dc.readyState === "open") return resolve();
        const t = setTimeout(() => reject(new Error("DataChannel open timed out")), 15_000);
        dc.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      });

      // 7. Auth
      const sendJson = (obj: object) => dc.send(JSON.stringify(obj));
      const waitMsg = (): Promise<{ cmd: string; [k: string]: unknown }> =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("Timed out waiting for message")), 30_000);
          dc.addEventListener("message", (e: MessageEvent<string>) => {
            clearTimeout(t);
            try { resolve(JSON.parse(e.data)); } catch { reject(new Error("Invalid message")); }
          }, { once: true });
        });

      sendJson({ cmd: "auth", capability_secret: creds.capability_secret });
      const authResp = await waitMsg();
      if (authResp.cmd !== "auth_ok") throw new Error(`Auth rejected: ${authResp.cmd}`);

      // 8. Send file chunks
      let offset = 0;
      while (offset < fileBytes.length) {
        const end = Math.min(offset + 16 * 1024, fileBytes.length);
        dc.send(fileBytes.slice(offset, end));
        offset = end;
        while (dc.bufferedAmount > 32 * 1024 && dc.readyState === "open")
          await new Promise((r) => setTimeout(r, 50));
        if (dc.readyState !== "open") throw new Error("DataChannel closed");
      }

      // 9. Complete
      sendJson({ cmd: "transfer_complete" });
      const done = await waitMsg();
      if (done.cmd !== "transfer_ok") throw new Error(`Transfer failed: ${done.cmd}`);

      pc.close();
      return { hash: done.hash as string, size: done.size as number, game_id: (done.game_id as string) ?? null };
    },
    { serverId, creds, fileBytesB64, fileName },
  );
}

// ── Download via HTTP polling ──────────────────────────────────────────

export async function downloadRomInBrowser(
  page: Page,
  serverId: string,
  gameId: string,
): Promise<DownloadResult> {
  return page.evaluate(
    async ({ serverId, gameId }) => {
      const csrf = () => {
        const c = document.cookie.split(";").map((p) => p.trim())
          .find((p) => p.startsWith("sc_csrf_token="))
          ?.split("=").slice(1).join("=");
        return c ? decodeURIComponent(c) : "";
      };

      // Queue download
      const q = await fetch(`/api/servers/${encodeURIComponent(serverId)}/rom-downloads`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrf() },
        body: JSON.stringify({ game_id: gameId }),
      });
      if (!q.ok) {
        const err = (await q.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Download queue failed: HTTP ${q.status}`);
      }
      const { command_id } = (await q.json()) as { command_id: string };

      // Poll for download URL
      let url: string | null = null;
      const dl = Date.now() + 120_000;
      while (Date.now() < dl) {
        const p = await fetch(
          `/api/servers/${encodeURIComponent(serverId)}/rom-downloads?command_id=${encodeURIComponent(command_id)}`,
        );
        if (p.ok) {
          const d = (await p.json()) as { url?: string };
          if (d.url) { url = d.url; break; }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!url) throw new Error("Timed out waiting for download URL");

      // Fetch file
      const fr = await fetch(url);
      if (!fr.ok) throw new Error(`File download failed: HTTP ${fr.status}`);
      const buf = await fr.arrayBuffer();
      const bytes = new Uint8Array(buf);

      // Compute SHA-256
      const hb = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = Array.from(new Uint8Array(hb)).map((b) => b.toString(16).padStart(2, "0")).join("");

      // Base64 encode
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return { sha256, size: bytes.length, bytesB64: btoa(bin) };
    },
    { serverId, gameId },
  );
}

// ── Helpers (Node.js side) ─────────────────────────────────────────────

import { createHash } from "node:crypto";

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function generateTestRom(): { bytes: Uint8Array; sha256: string } {
  const bytes = new Uint8Array(new TextEncoder().encode("hello-rom-transfer-631!"));
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256: hash };
}

export function generateLargeTestRom(
  sizeBytes: number,
  pattern: number = 0xab,
): { bytes: Uint8Array; sha256: string } {
  const bytes = new Uint8Array(sizeBytes);
  bytes.fill(pattern);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256: hash };
}
