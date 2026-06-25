"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useInterval } from "@/lib/poll";
import { Badge, Button, Toast } from "@/components/ui";
import RemapPanel from "./GamePlayerRemapPanel";
import styles from "./GamePlayer.module.css";
import {
  type StepState,
  PIPELINE_STEPS,
  defaultPipeline,
  mergePipeline,
  routeVariant,
  dotColor,
  dotChar,
  labelColor,
} from "./GamePlayerPipeline";

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
  sessionId?: string;
  initialPipeline?: Record<string, StepState>;
}

// ── Component ─────────────────────────────────────────────────────────

export default function GamePlayer({
  gameId,
  serverId,
  gameName,
  onClose,
  sessionId,
  initialPipeline,
}: GamePlayerProps) {
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
  const [showRemap, setShowRemap] = useState(false);
  const [remapWaiting, setRemapWaiting] = useState<string | null>(null);
  const [showRoomControls, setShowRoomControls] = useState(false);

  const [pipeline, setPipeline] = useState<Record<string, StepState>>(
    () => mergePipeline(defaultPipeline(), initialPipeline),
  );

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false);

  // ── Pipeline helpers ──────────────────────────────────────────────

  const advanceStep = useCallback((stepId: string) => {
    setPipeline((prev) => {
      const next: Record<string, StepState> = { ...prev };
      next[stepId] = "done";
      const idx = PIPELINE_STEPS.findIndex((s) => s.id === stepId);
      if (idx >= 0 && idx < PIPELINE_STEPS.length - 1) {
        const nextId = PIPELINE_STEPS[idx + 1].id;
        if (next[nextId] === "pending") next[nextId] = "active";
      }
      return next;
    });
  }, []);

  const failStep = useCallback((stepId: string) => {
    setPipeline((prev) => {
      const next: Record<string, StepState> = { ...prev };
      next[stepId] = "failed";
      return next;
    });
  }, []);

  const retryStep = useCallback((_stepId: string) => {
    setError(null);
    window.location.reload();
  }, []);

  // ── Toast ─────────────────────────────────────────────────────────

  const showToast = useCallback((text: string, ok: boolean) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }, []);

  // ── DC command helper ────────────────────────────────────────────

  const sendDC = useCallback((cmd: Record<string, unknown>) => {
    const p = playerRef.current;
    if (!p?._dc || p._dc.readyState !== "open") return false;
    try {
      p._dc.send(JSON.stringify(cmd));
      return true;
    } catch {
      return false;
    }
  }, []);

  // ── Controls auto-hide ────────────────────────────────────────────

  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(
      () => setControlsVisible(false),
      CONTROLS_HIDE_MS,
    );
  }, []);

  useEffect(() => {
    wakeControls();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [wakeControls]);

  // ── RTT polling ──────────────────────────────────────────────────

  useInterval(() => {
    if (playerRef.current?.rttMs != null) {
      setRttMs(playerRef.current.rttMs);
    }
  }, rttActive ? RTT_POLL_MS : null);

  // ── Player script ─────────────────────────────────────────────────

  useEffect(() => {
    if (window.gvPlay) {
      setScriptReady(true);
    }
  }, []);

  // ── Player init ───────────────────────────────────────────────────

  useEffect(() => {
    if (!scriptReady || !videoRef.current || !serverId) return;
    if (startedRef.current) return;

    const gvPlay = window.gvPlay;
    if (!gvPlay) return;

    startedRef.current = true;
    advanceStep("ice");

    const player = gvPlay.startPlayer(
      videoRef.current,
      serverId,
      gameId,
      null,
      {
        onStateChange(state: string, detail?: string) {
          setStatus(state);
          if (state === "connecting") {
            advanceStep("handshake");
          }
          if (state === "connected") {
            advanceStep("connected");
            setError(null);
            setConnected(true);
            setShowDisconnect(false);
          }
          if (state === "error") {
            const activeStep = PIPELINE_STEPS.find(
              (s) => pipeline[s.id] === "active",
            );
            if (activeStep) failStep(activeStep.id);
            setError(detail ?? "connection error");
            setConnected(false);
          }
          if (state === "idle") {
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
          const activeStep = PIPELINE_STEPS.find(
            (s) => pipeline[s.id] === "active",
          );
          if (activeStep) failStep(activeStep.id);
        },
        onProgress(msg: string) {
          setStatus(msg);
          if (msg.includes("Starting game")) advanceStep("game");
          else if (msg.includes("Worker")) advanceStep("worker");
          else if (msg.includes("handshak")) advanceStep("handshake");
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
  }, [scriptReady, serverId, gameId, showToast, advanceStep, failStep]);

  // ── Cleanup ───────────────────────────────────────────────────────

  useEffect(() => {
    const gid = gameId;
    const sid = serverId;
    return () => {
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

  // ── Fullscreen ────────────────────────────────────────────────────

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

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
      } catch { /* not supported */ }
    } else {
      await document.exitFullscreen();
    }
  };

  // ── Slots ─────────────────────────────────────────────────────────

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

  // ── Share ─────────────────────────────────────────────────────────

  const shareUrlSet = useRef(false);

  useEffect(() => {
    if (!connected) return;
    if (roomToken) return;
    (async () => {
      try {
        const resp = await fetch("/api/room/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            game_id: gameId,
            server_id: serverId,
            max_seats: 4,
          }),
        });
        if (!resp.ok) return;
        const data = await resp.json();
        setRoomToken(data.room_token);
        shareUrlSet.current = true;
      } catch { /* best-effort */ }
    })();
  }, [connected, gameId, serverId, roomToken]);

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className={styles.shell} onMouseMove={wakeControls} onKeyDown={wakeControls}>
      <style>{`
        @keyframes gv-pipeline-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>

      <Script src="/player/play.js" type="module" onLoad={() => setScriptReady(true)} />

      <video ref={videoRef} autoPlay playsInline muted className={styles.video} />

      {/* Top bar */}
      <div
        className={styles.topBar}
        style={{
          opacity: connected && controlsVisible ? 1 : 0,
          pointerEvents: connected && controlsVisible ? "auto" : "none",
        }}
      >
        <span className={styles.gameTitle}>{gameName || gameId}</span>
        {onClose && (
          <Button variant="secondary" size="md" onClick={onClose}>
            ← Back
          </Button>
        )}
      </div>

      {/* Bottom bar */}
      <div
        className={styles.bottomBar}
        style={{
          opacity: connected && controlsVisible ? 1 : 0,
          pointerEvents: connected && controlsVisible ? "auto" : "none",
        }}
      >
        <span className={styles.hint}>
          Arrows = Move &nbsp;|&nbsp; Z = A &nbsp;|&nbsp; X = B &nbsp;|&nbsp; Enter = Start
        </span>
        {route && (
          <Badge variant={routeVariant(route)} title={routeDetail || route}>
            {route}
          </Badge>
        )}
        <div className={styles.bottomRight}>
          <Button variant="secondary" size="sm" onClick={() => setShowRemap(!showRemap)}>
            🎮 Keys
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setShowRoomControls(!showRoomControls)}>
            ⚙ Room
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setShowSlots(!showSlots)}>
            💾 Slots
          </Button>
          <Button variant="secondary" size="sm" onClick={toggleFullscreen}>
            {isFullscreen ? "↙" : "⛶"}
          </Button>
        </div>
      </div>

      {/* Pipeline loading */}
      {!connected && !showDisconnect && (
        <div className={styles.centerMessage}>
          <p className={styles.loadingText}>
            {gameName ? `Starting ${gameName}` : "Starting game"}
          </p>
          <div className={styles.pipeline}>
            {PIPELINE_STEPS.map((step) => {
              const state = pipeline[step.id] || "pending";
              return (
                <div key={step.id} className={styles.stepRow}>
                  <span
                    className={styles.stepDot}
                    style={{
                      background: dotColor(state),
                      animation:
                        state === "active"
                          ? "gv-pipeline-pulse 1.2s ease-in-out infinite"
                          : undefined,
                    }}
                  >
                    {dotChar(state)}
                  </span>
                  <span className={styles.stepLabel} style={{ color: labelColor(state) }}>
                    {step.label}
                  </span>
                  {state === "failed" && (
                    <button
                      className={styles.retryBtn}
                      onClick={() => retryStep(step.id)}
                      title="Retry"
                    >
                      ↻
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {error && (
            <div className={styles.errorBox}>
              <p className={styles.pipelineError}>{error}</p>
              <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
                Retry
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Disconnect overlay */}
      {showDisconnect && (
        <div className={styles.overlay}>
          <div className={styles.overlayPanel}>
            {reconnectAttempt < 5 ? (
              <>
                <p className={styles.overlayTitle}>Connection lost</p>
                <p className={styles.overlaySub}>{reconnectMsg || "Reconnecting…"}</p>
              </>
            ) : (
              <>
                <p className={styles.overlayTitle}>Reconnection failed</p>
                <p className={styles.overlaySub}>Refresh the page to try again</p>
                <Button variant="secondary" onClick={() => window.location.reload()}>
                  Refresh
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Slots */}
      {showSlots && (
        <>
          <div className={styles.backdrop} onClick={() => setShowSlots(false)} />
          <div className={styles.slotPanel}>
            <div className={styles.slotHeader}>
              <span>Save</span>
              <Button variant="ghost" onClick={() => setShowSlots(false)}>✕</Button>
            </div>
            <div className={styles.slotRow}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <button key={`save-${n}`} className={styles.slotBtn} onClick={() => handleSave(n)}>
                  {n}
                </button>
              ))}
            </div>
            <div className={styles.slotHeader} style={{ marginTop: 12 }}>Load</div>
            <div className={styles.slotRow}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <button key={`load-${n}`} className={styles.slotBtn} onClick={() => handleLoad(n)}>
                  {n}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Key remap overlay */}
      {showRemap && (
        <>
          <div className={styles.backdrop} onClick={() => { setShowRemap(false); setRemapWaiting(null); }} />
          <RemapPanel
            playerRef={playerRef}
            waiting={remapWaiting}
            setWaiting={setRemapWaiting}
            onClose={() => { setShowRemap(false); setRemapWaiting(null); }}
          />
        </>
      )}

      {/* Room controls overlay */}
      {showRoomControls && (
        <>
          <div className={styles.backdrop} onClick={() => setShowRoomControls(false)} />
          <div className={styles.roomPanel}>
            <div className={styles.slotHeader}>
              <span>Room</span>
              <Button variant="ghost" onClick={() => setShowRoomControls(false)}>✕</Button>
            </div>
            <div className={styles.roomGrid}>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "reset" }); showToast("Reset", true); }}>
                ↺ Reset
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "save_state" }); showToast("Saved", true); }}>
                💾 Quick Save
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "load_state" }); showToast("Loaded", true); }}>
                📂 Quick Load
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "disk_eject" }); showToast("Disk ejected", true); }}>
                💿 Eject
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "disk_insert", index: 0 }); showToast("Disk 0 inserted", true); }}>
                💿 Insert 0
              </Button>
              {roomToken && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const url = `${window.location.origin}/play/${gameId}?join=${roomToken}`;
                    navigator.clipboard.writeText(url).then(
                      () => showToast("Share link copied!", true),
                      () => showToast("Copy failed", false)
                    );
                  }}
                >
                  🔗 Share Link
                </Button>
              )}
            </div>
          </div>
        </>
      )}

      {toast && (
        <Toast variant={toast.ok ? "success" : "error"} onDone={() => setToast(null)}>
          {toast.text}
        </Toast>
      )}
    </div>
  );
}
