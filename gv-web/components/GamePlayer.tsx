"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useInterval } from "@/lib/poll";
import { Badge, Button, Toast } from "@/components/ui";

// ── Constants ────────────────────────────────────────────────────────

const TOAST_DURATION_MS = 2_000;
const CONTROLS_HIDE_MS = 3_000;
const RTT_POLL_MS = 500;

// ── Types ─────────────────────────────────────────────────────────────

interface ToastData {
  text: string;
  ok: boolean;
}

interface GvPlay {
  startPlayer: (
    video: HTMLVideoElement,
    serverId: string,
    gameId: string,
    corePath: string | null,
    callbacks: PlayerCallbacks,
    joinToken?: string,
  ) => any;
  saveState: (player: any, slot: number) => boolean;
  loadState: (player: any, slot: number) => boolean;
}

interface PlayerCallbacks {
  onStateChange: (state: string, detail?: string) => void;
  onStats: (stats: object) => void;
  onSaveResult: (slot: number, ok: boolean) => void;
  onError: (msg: string) => void;
  onProgress: (msg: string) => void;
  onReconnecting: (attempt: number) => void;
  onReconnected: () => void;
  onReconnectFailed: () => void;
  onRoute?: (route: string, detail: string) => void;
}

declare global {
  interface Window {
    gvPlay?: GvPlay;
  }
}

// ── Props ─────────────────────────────────────────────────────────────

interface GamePlayerProps {
  gameId: string;
  serverId: string;
  gameName?: string;
  onClose?: () => void;
  /** Session ID for share/join deep linking. Optional — share hidden without it. */
  sessionId?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

function routeVariant(routeLabel: string) {
  const map: Record<string, "success" | "info" | "warning" | "error" | "muted"> = {
    local: "success",
    direct: "info",
    relay: "warning",
    failed: "error",
    unknown: "muted",
  };
  return map[routeLabel] || "muted";
}

// ── Component ─────────────────────────────────────────────────────────

export default function GamePlayer({ gameId, serverId, gameName, onClose, sessionId }: GamePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<any>(null);
  const searchParams = useSearchParams();
  const joinToken = searchParams.get("join") || undefined;

  const [status, setStatus] = useState("loading…");
  const [error, setError] = useState<string | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [showSlots, setShowSlots] = useState(false);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [reconnectMsg, setReconnectMsg] = useState("");
  const [toast, setToast] = useState<ToastData | null>(null);
  const [route, setRoute] = useState<string | null>(null);
  const [routeDetail, setRouteDetail] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);
  const [rttActive, setRttActive] = useState(false);
  const [roomToken, setRoomToken] = useState<string | null>(null);

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false);

  // ── Toast ─────────────────────────────────────────────────────────

  const showToast = useCallback((text: string, ok: boolean) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }, []);

  // ── Controls auto-hide ────────────────────────────────────────────

  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => {
    wakeControls();
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
  }, [wakeControls]);

  // ── RTT polling ──────────────────────────────────────────────────

  useInterval(() => {
    if (playerRef.current?.rttMs != null) {
      setRttMs(playerRef.current.rttMs);
    }
  }, rttActive ? RTT_POLL_MS : null);

  // ── Player script — check if already loaded ───────────────────────

  useEffect(() => {
    if (window.gvPlay) {
      setScriptReady(true);
    }
  }, []);

  // ── Player init (after script loads) ──────────────────────────────

  useEffect(() => {
    if (!scriptReady || !videoRef.current || !serverId) return;
    if (startedRef.current) return;

    const gvPlay = window.gvPlay;
    if (!gvPlay) return;

    startedRef.current = true;

    const player = gvPlay.startPlayer(
      videoRef.current,
      serverId,
      gameId,
      null,
      {
        onStateChange(state: string, detail?: string) {
          setStatus(state);
          if (state === "error") {
            setError(detail ?? "connection error");
            setConnected(false);
          }
          if (state === "connected") {
            setError(null);
            setConnected(true);
            setShowDisconnect(false);
          }
          if (state === "idle" || state === "connecting") {
            setConnected(false);
          }
        },
        onStats(_stats: object) {},
        onSaveResult(slot: number, ok: boolean) {
          showToast(
            ok ? `Saved to slot ${slot}` : `Save failed — slot ${slot}`,
            ok,
          );
        },
        onError(msg: string) {
          setError(msg);
        },
        onProgress(msg: string) {
          setStatus(msg);
        },
        onReconnecting(attempt: number) {
          setShowDisconnect(true);
          setReconnectAttempt(attempt);
          setReconnectMsg(`Reconnecting in 3s… (attempt ${attempt})`);
        },
        onReconnected() {
          setShowDisconnect(false);
          setReconnectAttempt(0);
          showToast("Reconnected", true);
        },
        onReconnectFailed() {
          setReconnectMsg("Reconnection failed — refresh the page");
        },
        onRoute(routeLabel: string, detail: string) {
          setRoute(routeLabel);
          setRouteDetail(detail);
        },
      },
      joinToken,
    );

    playerRef.current = player;
    setRttActive(true);

    return () => {
      setRttActive(false);
    };
  }, [scriptReady, serverId, gameId, showToast]);

  // ── Cleanup on unmount ────────────────────────────────────────────

  useEffect(() => {
    // Capture at mount time — gameId/serverId don't change within a lifecycle
    const gid = gameId;
    const sid = serverId;
    return () => {
      // Send stop_game so the server kills the worker. Fire-and-forget
      // so unmount isn't blocked if the network request hangs.
      if (gid && sid) {
        fetch("/api/server/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            server_id: sid,
            type: "stop_game",
            payload: { game_id: gid },
          }),
        }).catch(() => {});
      }
      if (playerRef.current) {
        playerRef.current.disconnect();
        playerRef.current = null;
      }
      startedRef.current = false;
    };
  }, []);

  // ── Fullscreen listener ───────────────────────────────────────────

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // ── Fullscreen ────────────────────────────────────────────────────

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      try {
        if (
          "orientation" in screen &&
          (screen.orientation as any)?.type?.startsWith?.("landscape")
        ) {
          await (screen.orientation as any).lock?.("landscape");
        }
      } catch { /* orientation lock not supported */ }
    } else {
      await document.exitFullscreen();
    }
  };

  // ── Save/load slot click ──────────────────────────────────────────

  const handleSave = (slot: number) => {
    const gvPlay = window.gvPlay;
    if (!gvPlay || !playerRef.current) {
      showToast("Not connected", false);
      return;
    }
    const ok = gvPlay.saveState(playerRef.current, slot);
    if (!ok) showToast("Not connected", false);
  };

  const handleLoad = (slot: number) => {
    const gvPlay = window.gvPlay;
    if (!gvPlay || !playerRef.current) {
      showToast("Not connected", false);
      return;
    }
    const ok = gvPlay.loadState(playerRef.current, slot);
    if (!ok) showToast("Not connected", false);
  };

  // ── Share (deep link) — updates browser URL so it's copyable ────────
  const shareUrlSet = useRef(false);

  useEffect(() => {
    if (!connected) return;
    if (roomToken) return; // already fetched

    (async () => {
      try {
        const resp = await fetch("/api/room/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ game_id: gameId, server_id: serverId, max_seats: 4 }),
        });
        if (!resp.ok) return;
        const data = await resp.json();

        setRoomToken(data.room_token);
        shareUrlSet.current = true;
        window.history.replaceState(
          null,
          "",
          `/play/${gameId}?join=${data.room_token}`,
        );
      } catch { /* silently ignore — share is best-effort */ }
    })();
  }, [connected, gameId, serverId, roomToken]);

  // Restore original URL only on unmount (game closed), not on re-render
  useEffect(() => {
    const originalUrl = window.location.pathname + window.location.search;
    return () => {
      if (shareUrlSet.current) {
        window.history.replaceState(null, "", originalUrl);
      }
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div style={styles.shell} onMouseMove={wakeControls} onKeyDown={wakeControls}>
      <Script
        src="/player/play.js"
        type="module"
        onLoad={() => setScriptReady(true)}
      />

      {/* ── Game video ─────────────────────────────────── */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={styles.video}
      />

      {/* ── Top bar ───────────────────────────────────── */}
      <div
        style={{
          ...styles.topBar,
          opacity: connected && controlsVisible ? 1 : 0,
          pointerEvents: connected && controlsVisible ? "auto" : "none",
        }}
      >
        <span style={styles.gameTitle}>{gameName || gameId}</span>
        {onClose && (
          <Button variant="secondary" size="md" onClick={onClose}>
            ← Back
          </Button>
        )}
      </div>

      {/* ── Bottom bar ────────────────────────────────── */}
      <div
        style={{
          ...styles.bottomBar,
          opacity: connected && controlsVisible ? 1 : 0,
          pointerEvents: connected && controlsVisible ? "auto" : "none",
        }}
      >
        <span style={styles.hint}>
          Arrows = Move &nbsp;|&nbsp; Z = A &nbsp;|&nbsp; X = B &nbsp;|&nbsp; Enter = Start
        </span>
        {route && (
          <Badge variant={routeVariant(route)} title={routeDetail || route}>
            {route}
          </Badge>
        )}
        <div style={styles.bottomRight}>
          <Button variant="secondary" size="sm" onClick={() => setShowSlots(!showSlots)}>
            💾 Slots
          </Button>
          <Button variant="secondary" size="sm" onClick={toggleFullscreen}>
            {isFullscreen ? "↙" : "⛶"}
          </Button>
        </div>
      </div>

      {/* ── Connecting / loading state ─────────────────── */}
      {!connected && !showDisconnect && (
        <div style={styles.centerMessage}>
          <p style={styles.loadingText}>
            {status || `Starting ${gameName || "game"}…`}
          </p>
          {error && <p style={styles.errorText}>{error}</p>}
        </div>
      )}

      {/* ── Disconnect overlay ─────────────────────────── */}
      {showDisconnect && (
        <div style={styles.overlay}>
          <div style={styles.overlayPanel}>
            {reconnectAttempt < 5 ? (
              <>
                <p style={styles.overlayTitle}>Connection lost</p>
                <p style={styles.overlaySub}>
                  {reconnectMsg || "Reconnecting…"}
                </p>
              </>
            ) : (
              <>
                <p style={styles.overlayTitle}>Reconnection failed</p>
                <p style={styles.overlaySub}>Refresh the page to try again</p>
                <Button
                  variant="secondary"
                  onClick={() => window.location.reload()}
                >
                  Refresh
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Save/load panel ────────────────────────────── */}
      {showSlots && (
        <>
          <div style={styles.backdrop} onClick={() => setShowSlots(false)} />
          <div style={styles.slotPanel}>
            <div style={styles.slotHeader}>
              <span>Save</span>
              <Button variant="ghost" onClick={() => setShowSlots(false)}>
                ✕
              </Button>
            </div>
            <div style={styles.slotRow}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <button key={`save-${n}`} style={styles.slotBtn} onClick={() => handleSave(n)}>
                  {n}
                </button>
              ))}
            </div>
            <div style={{ ...styles.slotHeader, marginTop: 12 }}>Load</div>
            <div style={styles.slotRow}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <button key={`load-${n}`} style={styles.slotBtn} onClick={() => handleLoad(n)}>
                  {n}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Toast ─────────────────────────────────────── */}
      {toast && (
        <Toast variant={toast.ok ? "success" : "error"} onDone={() => setToast(null)}>
          {toast.text}
        </Toast>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  shell: {
    position: "relative",
    width: "100%",
    height: "100%",
    background: "#000",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-md)",
    color: "var(--color-cream)",
  },
  video: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain",
    imageRendering: "pixelated",
    background: "#000",
  },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--space-4) var(--space-6)",
    background: "rgba(0,0,0,0.6)",
    zIndex: 10,
    transition: "opacity 0.3s",
  },
  gameTitle: {
    color: "var(--color-cream)",
    fontSize: "var(--font-size-lg)",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--space-4) var(--space-6)",
    background: "rgba(0,0,0,0.6)",
    zIndex: 10,
    transition: "opacity 0.3s",
  },
  hint: {
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
  },
  bottomRight: {
    display: "flex",
    gap: "var(--space-4)",
  },
  centerMessage: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    textAlign: "center" as const,
    zIndex: 20,
  },
  loadingText: {
    color: "var(--color-cream)",
    fontSize: "var(--font-size-md)",
    fontFamily: "var(--font-mono)",
  },
  errorText: {
    color: "var(--color-error)",
    fontSize: "var(--font-size-base)",
    marginTop: "var(--space-4)",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    background: "rgba(0,0,0,0.75)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 30,
  },
  overlayPanel: {
    textAlign: "center" as const,
    padding: "var(--space-8)",
  },
  overlayTitle: {
    color: "var(--color-cream)",
    fontSize: "var(--font-size-xl)",
    fontFamily: "var(--font-mono)",
    margin: "0 0 var(--space-4)",
  },
  overlaySub: {
    color: "var(--color-muted)",
    fontSize: "var(--font-size-md)",
    margin: "0 0 var(--space-6)",
  },
  backdrop: {
    position: "absolute",
    inset: 0,
    zIndex: 25,
  },
  slotPanel: {
    position: "absolute",
    bottom: 56,
    left: "50%",
    transform: "translateX(-50%)",
    background: "var(--color-mahogany)",
    border: "1px solid var(--color-brass)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-5) var(--space-6)",
    zIndex: 26,
  },
  slotHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-mono)",
    color: "var(--color-muted)",
    marginBottom: "var(--space-4)",
  },
  slotRow: {
    display: "flex",
    gap: "var(--space-3)",
  },
  slotBtn: {
    width: 32,
    height: 32,
    background: "var(--color-walnut)",
    color: "var(--color-cream)",
    border: "1px solid var(--color-bamboo)",
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-md)",
    borderRadius: "var(--radius-sm)",
  },
};
