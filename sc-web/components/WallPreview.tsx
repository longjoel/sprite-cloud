"use client";

import { useEffect, useRef, useState } from "react";

// ── WallPreview — lightweight WebRTC viewer for wall game cards

interface WallPreviewProps {
  roomToken: string;
  gameId: string;
  serverId: string;
  active: boolean; // only connect when card is visible/hovered
  onConnected?: () => void; // fired once when video starts playing
}

export default function WallPreview({
  roomToken,
  gameId,
  serverId,
  active,
  onConnected,
}: WallPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [connected, setConnected] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!active) {
      // Pause when out of view
      videoRef.current?.pause();
      return;
    }
    if (connected) {
      videoRef.current?.play().catch(() => {});
      return;
    }

    const controller = new AbortController();
    let cleanup = false;

    (async () => {
      try {
        // 1. Mint a viewer-only preview peer token. `preview: true` +
        //    stable client_id → spectator seat beyond maxSeats (never
        //    consumes a player slot), idempotent across re-renders.
        const joinRes = await fetch("/api/room/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room_token: roomToken, preview: true, client_id: `preview:${roomToken}` }),
          signal: controller.signal,
        });
        if (!joinRes.ok) throw new Error(`join failed: ${joinRes.status}`);
        const join = await joinRes.json() as {
          worker_url: string;
          peer_token: string;
          ice_servers?: { urls: string | string[]; username?: string; credential?: string }[];
        };
        if (!join.peer_token) throw new Error("no peer_token");

        // 2. Build RTCPeerConnection
        const pcConfig: RTCConfiguration = {};
        if (join.ice_servers?.length) {
          pcConfig.iceServers = join.ice_servers.map((s) => ({
            urls: Array.isArray(s.urls) ? s.urls : [s.urls],
            username: s.username,
            credential: s.credential,
          }));
        }
        const pc = new RTCPeerConnection(pcConfig);
        pcRef.current = pc;

        // Collect stream tracks — set srcObject ONCE, play after ICE connects
        const stream = new MediaStream();
        streamRef.current = stream;
        let ontrackFired = false;
        pc.ontrack = (ev) => {
          const tracks = ev.streams[0]?.getTracks() ?? [];
          console.log("[wall-preview] ontrack:", tracks.map(t => t.kind).join(","));
          for (const track of tracks) {
            stream.addTrack(track);
          }
          if (!ontrackFired && videoRef.current) {
            ontrackFired = true;
            videoRef.current.srcObject = stream;
            videoRef.current.muted = true;
            videoRef.current.playsInline = true;
            // Defer play() until ICE is connected so frames can flow
            if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
              videoRef.current.play().catch((e: Error) => console.warn("[wall-preview] play:", e.message));
              setConnected(true);
              onConnected?.();
            }
          }
        };

        pc.oniceconnectionstatechange = () => {
          console.log("[wall-preview] ICE:", pc.iceConnectionState);
          if ((pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed")
            && videoRef.current && ontrackFired && !connected) {
            videoRef.current.play().then(() => {
              console.log("[wall-preview] playing");
              setConnected(true);
              onConnected?.();
            }).catch((e: Error) => console.warn("[wall-preview] play:", e.message));
          }
        };

        // 3. Create SDP offer and send via gateway command relay
        const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);

        // Wait for ICE gathering
        await new Promise<void>((resolve, reject) => {
          if (pc.iceGatheringState === "complete") resolve();
          // Timeout fallback
          const fallback = setTimeout(() => {
            console.warn("[wall-preview] ICE gathering fallback after 3s");
            resolve();
          }, 3000);
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === "complete") {
              clearTimeout(fallback);
              resolve();
            }
          };
          if (controller.signal.aborted) {
            clearTimeout(fallback);
            reject(new Error("aborted"));
          }
          controller.signal.addEventListener("abort", () => {
            clearTimeout(fallback);
            reject(new Error("aborted"));
          });
        });

        // 4. Send guest SDP to gateway
        const cmdRes = await fetch("/api/server/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            server_id: serverId,
            type: "sdp_offer",
            payload: {
              game_id: gameId,
              sdp: pc.localDescription?.sdp ?? "",
              room_token: roomToken,
              peer_token: join.peer_token,
            },
          }),
          signal: controller.signal,
        });
        if (!cmdRes.ok) throw new Error(`command failed: ${cmdRes.status}`);
        const cmd = await cmdRes.json() as { id: string; worker_token: string };

        // 5. Poll for SDP answer via notify/poll
        const workerToken = cmd.worker_token;
        for (let i = 0; i < 60; i++) {
          if (cleanup || controller.signal.aborted) break;
          await new Promise((r) => setTimeout(r, 500));
          const pollRes = await fetch("/api/server/notify/poll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ server_id: serverId, worker_token: workerToken }),
            signal: controller.signal,
          });
          if (!pollRes.ok) continue;
          const poll = await pollRes.json() as { sdp_answer?: string; error?: string; message?: string };
          if (poll.error) throw new Error(poll.error + (poll.message ? ": " + poll.message : ""));
          if (poll.sdp_answer) {
            await pc.setRemoteDescription(
              new RTCSessionDescription({ type: "answer", sdp: poll.sdp_answer })
            );
            return; // ontrack will fire
          }
        }
      } catch (err) {
        if (!cleanup && !controller.signal.aborted) {
          console.warn("[wall-preview] connect failed:", err);
        }
        pcRef.current?.close();
        pcRef.current = null;
      }
    })();

    return () => {
      cleanup = true;
      controller.abort();
      pcRef.current?.close();
      pcRef.current = null;
    };
  }, [active, roomToken, gameId, serverId, onConnected]); // removed 'connected' — don't kill PC on state change

  return (
    <video
      ref={videoRef}
      muted
      playsInline
      disablePictureInPicture
      style={{
        width: "100%",
        height: "100%",
        objectFit: "contain",
        background: "#000",
      }}
    />
  );
}
