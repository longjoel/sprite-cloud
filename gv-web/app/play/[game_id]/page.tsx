"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

// ── Constants ────────────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const TOAST_DURATION_MS = 2_000;
const CONTROLS_HIDE_MS = 3_000;

// ── Types ─────────────────────────────────────────────────────────────

interface Toast {
  text: string;
  ok: boolean;
}

// ── Page ──────────────────────────────────────────────────────────────

export default function PlayPage() {
  const routeParams = useParams<{ game_id: string }>();
  const searchParams = useSearchParams();

  const gameId = routeParams.game_id;
  const serverId = searchParams.get("server_id") ?? "";
  const workerToken = searchParams.get("worker_token") ?? "";

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
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // ── Missing params guard ──────────────────────────────────────────

  if (!serverId || !workerToken) {
    return (
      <main style={styles.shell}>
        <div style={styles.centerMessage}>
          <p>Missing connection parameters.</p>
          <p style={styles.hint}>
            Expected: /play/:game_id?server_id=&amp;worker_token=
          </p>
        </div>
      </main>
    );
  }

  // ── Fullscreen ────────────────────────────────────────────────────

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      // Only lock landscape if already landscape — don't force on portrait mobile
      try {
        if (
          "orientation" in screen &&
          (screen.orientation as any)?.type?.startsWith?.("landscape")
        ) {
          await (screen.orientation as any).lock?.("landscape");
        }
      } catch { /* orientation lock not supported */ }
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  // ── Save/load slot click ──────────────────────────────────────────

  const handleSave = (slot: number) => {
    // Wired in Task 3
    showToast(`Saved to slot ${slot}`, true);
  };

  const handleLoad = (slot: number) => {
    // Wired in Task 3
    showToast(`Loaded from slot ${slot}`, true);
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <main style={styles.shell} onMouseMove={wakeControls} onKeyDown={wakeControls}>
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
          opacity: controlsVisible ? 1 : 0,
          pointerEvents: controlsVisible ? "auto" : "none",
        }}
      >
        <span style={styles.gameTitle}>{gameId}</span>
        {rttMs !== null && (
          <span
            style={{
              ...styles.rtt,
              color: rttMs < 30 ? "#2a2" : rttMs < 100 ? "#aa2" : "#a22",
            }}
          >
            RTT {Math.round(rttMs)}ms
          </span>
        )}
      </div>

      {/* ── Bottom bar ─────────────────────────────────────────── */}
      <div
        style={{
          ...styles.bottomBar,
          opacity: controlsVisible ? 1 : 0,
          pointerEvents: controlsVisible ? "auto" : "none",
        }}
      >
        <span style={styles.hint}>
          Q=Start W=Select | arrows/WASD=move | Z=B X=A
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

      {/* ── Status (connecting state) ──────────────────────────── */}
      {status !== "connected" && !showDisconnect && (
        <div style={styles.centerMessage}>
          <p>
            {status}
            {error ? `: ${error}` : ""}
          </p>
        </div>
      )}

      {/* ── Disconnect overlay ─────────────────────────────────── */}
      {showDisconnect && (
        <div style={styles.overlay}>
          <div style={styles.overlayPanel}>
            {reconnectAttempt < MAX_RECONNECT_ATTEMPTS ? (
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

      {/* ── Status text (bottom edge, debug) ───────────────────── */}
      {status !== "connected" && (
        <pre style={styles.debugStatus}>
          {status}
          {error ? ` — ${error}` : ""}
        </pre>
      )}
    </main>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  shell: {
    position: "relative",
    width: "100vw",
    height: "100vh",
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
    pointerEvents: "none",
  },
  gameTitle: {
    color: "#fff",
    fontSize: 14,
  },
  rtt: {
    fontSize: 12,
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
    pointerEvents: "none",
  },
  hint: {
    fontSize: 12,
    color: "#888",
  },
  bottomRight: {
    display: "flex",
    gap: 8,
    pointerEvents: "auto",
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
    pointerEvents: "auto",
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
    bottom: 48,
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(0,0,0,0.92)",
    border: "1px solid #333",
    borderRadius: 4,
    padding: "12px 16px",
    zIndex: 26,
    pointerEvents: "auto",
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
    pointerEvents: "none",
  },
  debugStatus: {
    position: "absolute",
    bottom: 4,
    right: 8,
    fontSize: 10,
    color: "#444",
    zIndex: 5,
    margin: 0,
  },
};
