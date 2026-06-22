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

// ── Pipeline ──────────────────────────────────────────────────────────

type StepState = "pending" | "active" | "done" | "failed";

interface PipelineStep {
  id: string;
  label: string;
}

const PIPELINE_STEPS: PipelineStep[] = [
  { id: "ice", label: "ICE" },
  { id: "server", label: "Server" },
  { id: "game", label: "Game" },
  { id: "worker", label: "Worker" },
  { id: "handshake", label: "Handshake" },
  { id: "connected", label: "Playing" },
];

function defaultPipeline(): Record<string, StepState> {
  const out: Record<string, StepState> = {};
  for (const s of PIPELINE_STEPS) {
    out[s.id] = s.id === "ice" ? "active" : "pending";
  }
  return out;
}

function mergePipeline(
  base: Record<string, StepState>,
  overrides?: Record<string, StepState>,
): Record<string, StepState> {
  if (!overrides) return base;
  return { ...base, ...overrides };
}

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

// ── Pipeline dot helpers ──────────────────────────────────────────────

function dotColor(state: StepState): string {
  switch (state) {
    case "done": return "var(--color-success)";
    case "failed": return "var(--color-error)";
    case "active": return "var(--color-brass)";
    default: return "var(--color-walnut)";
  }
}

function dotChar(state: StepState): string {
  switch (state) {
    case "done": return "✓";
    case "failed": return "✖";
    case "active": return "●";
    default: return "○";
  }
}

function labelColor(state: StepState): string {
  switch (state) {
    case "active": return "var(--color-cream)";
    case "failed": return "var(--color-error)";
    case "done": return "var(--color-success)";
    default: return "var(--color-muted)";
  }
}

// ── Key remap labels ─────────────────────────────────────────────────

const BUTTON_LABELS: Record<number, string> = {
  0: "B", 1: "Y", 2: "Select", 3: "Start", 4: "Up", 5: "Down",
  6: "Left", 7: "Right", 8: "A", 9: "X", 10: "L", 11: "R",
  12: "L2", 13: "R2", 14: "L3", 15: "R3",
};

// ── Remap panel ──────────────────────────────────────────────────────

function RemapPanel({
  playerRef,
  waiting,
  setWaiting,
  onClose,
}: {
  playerRef: React.RefObject<any>;
  waiting: string | null;
  setWaiting: (v: string | null) => void;
  onClose: () => void;
}) {
  const mapping = playerRef.current?.getKeyMapping?.() || {};

  // Build reverse map: bit → [keys]
  const bitKeys: Record<number, string[]> = {};
  for (const [key, bit] of Object.entries(mapping)) {
    const b = bit as number;
    if (!bitKeys[b]) bitKeys[b] = [];
    bitKeys[b].push(key);
  }

  // Listen for next keypress when waiting
  // Import useEffect at top of RemapPanel — already available via module scope
  useEffect(() => {
    if (!waiting) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const bit = parseInt(waiting);
      if (playerRef.current?.setKeyMapping) {
        playerRef.current.setKeyMapping(e.key, bit);
      }
      setWaiting(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [waiting, playerRef, setWaiting]);

  return (
    <div style={remapStyles.panel}>
      <div style={remapStyles.header}>
        <span>Key Mapping</span>
        <div style={{ display: "flex", gap: "var(--space-3)" }}>
          <button
            style={remapStyles.resetBtn}
            onClick={() => {
              playerRef.current?.resetKeymap?.();
              onClose();
            }}
          >
            Reset defaults
          </button>
          <button style={remapStyles.closeBtn} onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      {waiting && (
        <p style={remapStyles.waiting}>
          Press a key for {BUTTON_LABELS[parseInt(waiting)] || `bit ${waiting}`}…
        </p>
      )}
      <div style={remapStyles.grid}>
        {Object.entries(BUTTON_LABELS).map(([bitStr, label]) => {
          const bit = parseInt(bitStr);
          const keys = bitKeys[bit] || [];
          return (
            <button
              key={bit}
              style={{
                ...remapStyles.cell,
                outline:
                  waiting === bitStr
                    ? "2px solid var(--color-brass)"
                    : undefined,
              }}
              onClick={() => setWaiting(bitStr)}
            >
              <span style={remapStyles.cellLabel}>{label}</span>
              <span style={remapStyles.cellKey}>
                {keys.length > 0 ? keys.slice(0, 3).join(", ") : "—"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const remapStyles: Record<string, React.CSSProperties> = {
  panel: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    background: "rgba(0,0,0,0.95)",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-6)",
    zIndex: 27,
    maxWidth: 380,
    width: "90vw",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "var(--space-4)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
  },
  waiting: {
    textAlign: "center" as const,
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-brass)",
    marginBottom: "var(--space-3)",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "var(--space-2)",
  },
  cell: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--space-2) var(--space-3)",
    background: "var(--color-walnut)",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-cream)",
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-xs)",
  },
  cellLabel: { fontWeight: 600 },
  cellKey: { color: "var(--color-cyan)", fontSize: 10 },
  resetBtn: {
    background: "none",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-muted)",
    cursor: "pointer",
    fontSize: 10,
    padding: "2px 6px",
    fontFamily: "var(--font-mono)",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--color-muted)",
    cursor: "pointer",
    fontSize: 14,
  },
};

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
        window.history.replaceState(
          null,
          "",
          `/play/${gameId}?join=${data.room_token}`,
        );
      } catch { /* best-effort */ }
    })();
  }, [connected, gameId, serverId, roomToken]);

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
      <style>{`
        @keyframes gv-pipeline-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>

      <Script src="/player/play.js" type="module" onLoad={() => setScriptReady(true)} />

      <video ref={videoRef} autoPlay playsInline muted style={styles.video} />

      {/* Top bar */}
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

      {/* Bottom bar */}
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
        <div style={styles.centerMessage}>
          <p style={styles.loadingText}>
            {gameName ? `Starting ${gameName}` : "Starting game"}
          </p>
          <div style={styles.pipeline}>
            {PIPELINE_STEPS.map((step) => {
              const state = pipeline[step.id] || "pending";
              return (
                <div key={step.id} style={styles.stepRow}>
                  <span
                    style={{
                      ...styles.stepDot,
                      background: dotColor(state),
                      animation:
                        state === "active"
                          ? "gv-pipeline-pulse 1.2s ease-in-out infinite"
                          : undefined,
                    }}
                  >
                    {dotChar(state)}
                  </span>
                  <span style={{ ...styles.stepLabel, color: labelColor(state) }}>
                    {step.label}
                  </span>
                  {state === "failed" && (
                    <button
                      style={styles.retryBtn}
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
            <div style={styles.errorBox}>
              <p style={styles.pipelineError}>{error}</p>
              <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
                Retry
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Disconnect overlay */}
      {showDisconnect && (
        <div style={styles.overlay}>
          <div style={styles.overlayPanel}>
            {reconnectAttempt < 5 ? (
              <>
                <p style={styles.overlayTitle}>Connection lost</p>
                <p style={styles.overlaySub}>{reconnectMsg || "Reconnecting…"}</p>
              </>
            ) : (
              <>
                <p style={styles.overlayTitle}>Reconnection failed</p>
                <p style={styles.overlaySub}>Refresh the page to try again</p>
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
          <div style={styles.backdrop} onClick={() => setShowSlots(false)} />
          <div style={styles.slotPanel}>
            <div style={styles.slotHeader}>
              <span>Save</span>
              <Button variant="ghost" onClick={() => setShowSlots(false)}>✕</Button>
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

      {/* Key remap overlay */}
      {showRemap && (
        <>
          <div style={styles.backdrop} onClick={() => { setShowRemap(false); setRemapWaiting(null); }} />
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
          <div style={styles.backdrop} onClick={() => setShowRoomControls(false)} />
          <div style={styles.roomPanel}>
            <div style={styles.slotHeader}>
              <span>Room</span>
              <Button variant="ghost" onClick={() => setShowRoomControls(false)}>✕</Button>
            </div>
            <div style={styles.roomGrid}>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "reset" }); showToast("Reset", true); }}>
                ↺ Reset
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "save_state", slot: 1 }); showToast("Saved slot 1", true); }}>
                💾 Quick Save
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "load_state", slot: 1 }); showToast("Loaded slot 1", true); }}>
                📂 Quick Load
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "disk_eject" }); showToast("Disk ejected", true); }}>
                💿 Eject
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "disk_insert", index: 0 }); showToast("Disk 0 inserted", true); }}>
                💿 Insert 0
              </Button>
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
    fontSize: "var(--font-size-md)",
    color: "var(--color-cream)",
    fontFamily: "var(--font-mono)",
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--space-3) var(--space-6)",
    background: "rgba(0,0,0,0.6)",
    zIndex: 10,
    transition: "opacity 0.3s",
    gap: "var(--space-4)",
  },
  hint: {
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
  },
  bottomRight: { display: "flex", gap: "var(--space-3)" },
  centerMessage: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    textAlign: "center" as const,
    zIndex: 20,
    maxWidth: "90vw",
  },
  loadingText: {
    fontFamily: "var(--font-mono)",
    color: "var(--color-cream)",
    fontSize: "var(--font-size-lg)",
    marginBottom: "var(--space-6)",
  },
  pipeline: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "var(--space-3)",
    marginBottom: "var(--space-5)",
  },
  stepRow: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  stepDot: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    borderRadius: "50%",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    color: "#000",
    fontWeight: 700,
    flexShrink: 0,
  },
  stepLabel: { fontSize: "var(--font-size-sm)", fontFamily: "var(--font-mono)" },
  retryBtn: {
    marginLeft: "var(--space-2)",
    background: "none",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-brass)",
    cursor: "pointer",
    fontSize: 14,
    padding: "2px 6px",
    fontFamily: "var(--font-mono)",
    lineHeight: 1,
  },
  errorBox: {
    marginTop: "var(--space-4)",
    display: "flex",
    flexDirection: "column" as const,
    gap: "var(--space-3)",
    alignItems: "center",
  },
  pipelineError: {
    fontSize: "var(--font-size-sm)",
    color: "var(--color-error)",
    fontFamily: "var(--font-mono)",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    background: "rgba(0,0,0,0.85)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 30,
  },
  overlayPanel: { textAlign: "center" as const, padding: "var(--space-8)" },
  overlayTitle: {
    fontSize: "var(--font-size-h3)",
    color: "var(--color-cream)",
    fontFamily: "var(--font-mono)",
    marginBottom: "var(--space-4)",
  },
  overlaySub: {
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-mono)",
    marginBottom: "var(--space-6)",
  },
  backdrop: { position: "absolute", inset: 0, zIndex: 25 },
  slotPanel: {
    position: "absolute",
    bottom: "var(--space-16)",
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(0,0,0,0.9)",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-6)",
    zIndex: 26,
  },
  slotHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "var(--space-4)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
  },
  slotRow: { display: "flex", gap: "var(--space-2)" },
  slotBtn: {
    width: 32,
    height: 32,
    borderRadius: "var(--radius-sm)",
    background: "var(--color-walnut)",
    color: "var(--color-cream)",
    border: "1px solid var(--color-bamboo)",
    cursor: "pointer",
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-mono)",
  },
  roomPanel: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    background: "rgba(0,0,0,0.95)",
    border: "1px solid var(--color-bamboo)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-6)",
    zIndex: 27,
    minWidth: 220,
  },
  roomGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "var(--space-2)",
    marginTop: "var(--space-3)",
  },
};
