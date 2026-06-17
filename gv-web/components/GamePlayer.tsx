"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

// ── Constants ────────────────────────────────────────────────────────

const TOAST_DURATION_MS = 2_000;
const CONTROLS_HIDE_MS = 3_000;
const RTT_POLL_MS = 500;

// ── Types ─────────────────────────────────────────────────────────────

interface Toast {
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
}

// ── Component ─────────────────────────────────────────────────────────

export default function GamePlayer({ gameId, serverId, gameName, onClose }: GamePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<any>(null);

  const [status, setStatus] = useState("loading…");
  const [error, setError] = useState<string | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [showSlots, setShowSlots] = useState(false);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [reconnectMsg, setReconnectMsg] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [route, setRoute] = useState<string | null>(null);
  const [routeDetail, setRouteDetail] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);

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

  // ── Player script — check if already loaded (next/script caches it) ─

  useEffect(() => {
    // If the script was already loaded in a previous mount (modal reopen),
    // gvPlay is already on window.  Set scriptReady immediately.
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

    let rttTimer: ReturnType<typeof setInterval> | null = null;

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
    );

    playerRef.current = player;

    // RTT polling
    rttTimer = setInterval(() => {
      if (player.rttMs != null) {
        setRttMs(player.rttMs);
      }
    }, RTT_POLL_MS);

    return () => {
      if (rttTimer) clearInterval(rttTimer);
    };
  }, [scriptReady, serverId, gameId, showToast]);

  // ── Cleanup on unmount ────────────────────────────────────────────

  useEffect(() => {
    return () => {
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

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div style={styles.shell} onMouseMove={wakeControls} onKeyDown={wakeControls}>
      {/* ── Load player script ────────────────────────────────── */}
      <Script
        src="/player/play.js"
        type="module"
        onLoad={() => setScriptReady(true)}
      />

      {/* ── Game video ─────────────────────────────────────────── */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={styles.video}
      />

      {/* ── Top bar ────────────────────────────────────────────── */}
      <div
        style={{
          ...styles.topBar,
          opacity: connected && controlsVisible ? 1 : 0,
          pointerEvents: connected && controlsVisible ? "auto" : "none",
        }}
      >
        <span style={styles.gameTitle}>{gameName || gameId}</span>
        {onClose && (
          <button style={styles.backBtn} onClick={onClose}>
            ← Back
          </button>
        )}
      </div>

      {/* ── Bottom bar ─────────────────────────────────────────── */}
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
        <div style={styles.bottomRight}>
          <button style={styles.btn} onClick={() => setShowSlots(!showSlots)}>
            💾 Slots
          </button>
          <button style={styles.btn} onClick={toggleFullscreen}>
            {isFullscreen ? "↙" : "⛶"}
          </button>
        </div>
      </div>

      {/* ── Connecting / loading state ─────────────────────────── */}
      {!connected && !showDisconnect && (
        <div style={styles.centerMessage}>
          <p style={styles.loadingText}>{status || `Starting ${gameName || "game"}…`}</p>
          {error && <p style={styles.errorText}>{error}</p>}
        </div>
      )}

      {/* ── Disconnect overlay ─────────────────────────────────── */}
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
                <button
                  style={styles.btn}
                  onClick={() => window.location.reload()}
                >
                  Refresh
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Save/load panel ────────────────────────────────────── */}
      {showSlots && (
        <>
          <div style={styles.backdrop} onClick={() => setShowSlots(false)} />
          <div style={styles.slotPanel}>
            <div style={styles.slotHeader}>
              <span>Save</span>
              <button style={styles.btnClose} onClick={() => setShowSlots(false)}>
                ✕
              </button>
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

      {/* ── Toast ──────────────────────────────────────────────── */}
      {toast && (
        <div
          style={{
            ...styles.toast,
            borderColor: toast.ok ? "#2a2" : "#a22",
          }}
        >
          {toast.text}
        </div>
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
    fontFamily: "monospace",
    fontSize: 14,
    color: "#ccc",
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
    padding: "8px 16px",
    background: "rgba(0,0,0,0.6)",
    zIndex: 10,
    transition: "opacity 0.3s",
  },
  gameTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: 700,
  },
  backBtn: {
    background: "rgba(255,255,255,0.1)",
    border: "1px solid rgba(255,255,255,0.2)",
    color: "#fff",
    cursor: "pointer",
    fontSize: 14,
    fontFamily: "monospace",
    padding: "6px 16px",
    borderRadius: 4,
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 16px",
    background: "rgba(0,0,0,0.6)",
    zIndex: 10,
    transition: "opacity 0.3s",
  },
  hint: {
    fontSize: 12,
    color: "#888",
  },
  bottomRight: {
    display: "flex",
    gap: 8,
  },
  btn: {
    padding: "4px 14px",
    background: "#333",
    color: "#ccc",
    border: "1px solid #555",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 13,
    borderRadius: 2,
  },
  btnClose: {
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: 16,
    padding: 0,
    lineHeight: 1,
  },
  centerMessage: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    textAlign: "center" as const,
    zIndex: 20,
  },
  errorText: {
    color: "#a22",
    fontSize: 13,
    marginTop: 8,
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
    padding: 32,
  },
  overlayTitle: {
    color: "#fff",
    fontSize: 18,
    margin: "0 0 8px",
  },
  overlaySub: {
    color: "#888",
    fontSize: 14,
    margin: "0 0 16px",
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
    background: "rgba(0,0,0,0.92)",
    border: "1px solid #333",
    borderRadius: 4,
    padding: "12px 16px",
    zIndex: 26,
  },
  slotHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 12,
    color: "#888",
    marginBottom: 8,
  },
  slotRow: {
    display: "flex",
    gap: 6,
  },
  slotBtn: {
    width: 32,
    height: 32,
    background: "#222",
    color: "#ccc",
    border: "1px solid #444",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 14,
    borderRadius: 2,
  },
  toast: {
    position: "absolute",
    top: 48,
    left: "50%",
    transform: "translateX(-50%)",
    background: "#111",
    border: "1px solid #333",
    borderRadius: 4,
    padding: "8px 20px",
    fontSize: 13,
    zIndex: 40,
  },
};
