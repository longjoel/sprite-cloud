"use client";

import Script from "next/script";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
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
    hostToken?: string,
  ) => any;
  saveState: (player: any) => boolean;
  loadState: (player: any) => boolean;
  loadStateAt: (player: any, index: number) => boolean;
  listSaves: (player: any) => boolean;
}

interface PlayerCallbacks {
  onStateChange: (state: string, detail?: string) => void;
  onStats: (stats: object) => void;
  onSaveResult: (index: number, ok: boolean, error?: string) => void;
  onLoadResult: (ok: boolean, error?: string) => void;
  onListSaves: (entries: any[], nextIndex: number) => void;
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
  hostToken?: string;
  joinToken?: string;
  onClose?: () => void;
  sessionId?: string;
  initialPipeline?: Record<string, StepState>;
  initialStatus?: string;
}

// ── Connection state machine ──────────────────────────────────────────

type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

interface PlayerState {
  status: ConnectionStatus;
  statusText: string;
  error: string | null;
  connected: boolean;
  pipeline: Record<string, StepState>;
  reconnectAttempt: number;
  reconnectMsg: string;
  route: string | null;
  routeDetail: string | null;
  rttMs: number | null;
  rttActive: boolean;
}

type PlayerAction =
  | { type: "SCRIPT_READY" }
  | { type: "PLAYER_STARTING" }
  | { type: "GV_STATE"; gvState: string; detail?: string }
  | { type: "PROGRESS"; msg: string }
  | { type: "ERROR"; msg: string }
  | { type: "RECONNECTING"; attempt: number }
  | { type: "RECONNECTED" }
  | { type: "RECONNECT_FAILED" }
  | { type: "ROUTE"; route: string; detail: string }
  | { type: "SET_RTT"; ms: number }
  | { type: "SET_RTT_ACTIVE"; active: boolean }
  | { type: "CONNECTED_STEP" };

function initialPipelineState(
  overrides?: Record<string, StepState>,
): Record<string, StepState> {
  return mergePipeline(defaultPipeline(), overrides);
}

function initialPlayerState(
  overrides?: Record<string, StepState>,
): PlayerState {
  return {
    status: "idle",
    statusText: "Loading…",
    error: null,
    connected: false,
    pipeline: initialPipelineState(overrides),
    reconnectAttempt: 0,
    reconnectMsg: "",
    route: null,
    routeDetail: null,
    rttMs: null,
    rttActive: false,
  };
}

/** Advance a pipeline step to "done" and activate the next pending step. */
function advancePipelineStep(
  pipeline: Record<string, StepState>,
  stepId: string,
): Record<string, StepState> {
  const next: Record<string, StepState> = { ...pipeline };
  next[stepId] = "done";
  const idx = PIPELINE_STEPS.findIndex((s) => s.id === stepId);
  if (idx >= 0 && idx < PIPELINE_STEPS.length - 1) {
    const nextId = PIPELINE_STEPS[idx + 1].id;
    if (next[nextId] === "pending") next[nextId] = "active";
  }
  return next;
}

/** Mark a pipeline step as failed. */
function failPipelineStep(
  pipeline: Record<string, StepState>,
  stepId: string,
): Record<string, StepState> {
  const next: Record<string, StepState> = { ...pipeline };
  next[stepId] = "failed";
  return next;
}

/** Find the currently active pipeline step, if any. */
function activeStepId(pipeline: Record<string, StepState>): string | null {
  return PIPELINE_STEPS.find((s) => pipeline[s.id] === "active")?.id ?? null;
}

function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  // ── State-machine guard: log unexpected transitions ──────────
  const guard = (expected: ConnectionStatus[]) => {
    if (!expected.includes(state.status)) {
      console.warn(
        `[GamePlayer] state leak: got ${action.type} in status=${state.status} ` +
        `(expected one of [${expected.join("|")}])`,
        action,
      );
    }
  };

  switch (action.type) {
    case "SCRIPT_READY":
      if (state.status !== "idle") return state;
      return { ...state, statusText: "Starting…" };

    case "PLAYER_STARTING":
      guard(["idle"]);
      return {
        ...state,
        status: "connecting",
        statusText: "Starting game",
        pipeline: advancePipelineStep(state.pipeline, "ice"),
      };

    // ── GvPlayer state changes ────────────────────────────────────
    case "GV_STATE": {
      const { gvState, detail } = action;

      if (gvState === "connecting") {
        guard(["connecting", "reconnecting"]);
        if (state.status !== "connecting" && state.status !== "reconnecting")
          return state;
        return {
          ...state,
          pipeline: advancePipelineStep(state.pipeline, "server"),
        };
      }

      if (gvState === "connected") {
        guard(["connecting", "reconnecting"]);
        let p = advancePipelineStep(state.pipeline, "media");
        return {
          ...state,
          status: "connected",
          statusText: "Connected",
          connected: true,
          error: null,
          pipeline: p,
          reconnectAttempt: 0,
          reconnectMsg: "",
        };
      }

      if (gvState === "error") {
        guard(["connecting", "connected", "reconnecting"]);
        const failed = activeStepId(state.pipeline);
        let p = state.pipeline;
        if (failed) p = failPipelineStep(p, failed);
        return {
          ...state,
          status: "error",
          statusText: detail ?? "Connection error",
          error: detail ?? "connection error",
          connected: false,
          pipeline: p,
        };
      }

      if (gvState === "idle") {
        return { ...state, connected: false };
      }

      return state;
    }

    // ── Progress messages (pipeline step hints) ────────────────────
    case "PROGRESS": {
      guard(["connecting"]);
      const { msg } = action;
      let p = state.pipeline;
      if (msg.toLowerCase().includes("starting game")) {
        p = advancePipelineStep(p, "core");
      } else if (
        msg.toLowerCase().includes("worker") ||
        msg.toLowerCase().includes("sdp")
      ) {
        p = advancePipelineStep(p, "sdp");
      } else if (msg.toLowerCase().includes("handshak")) {
        p = advancePipelineStep(p, "encode");
      }
      return { ...state, statusText: msg, pipeline: p };
    }

    case "ERROR": {
      const failed = activeStepId(state.pipeline);
      let p = state.pipeline;
      if (failed) p = failPipelineStep(p, failed);
      return { ...state, error: action.msg, pipeline: p };
    }

    // ── Reconnect ──────────────────────────────────────────────────
    case "RECONNECTING":
      guard(["connected"]);
      return {
        ...state,
        status: "reconnecting",
        reconnectAttempt: action.attempt,
        reconnectMsg: `Reconnecting in 3s… (attempt ${action.attempt})`,
      };

    case "RECONNECTED":
      guard(["reconnecting"]);
      return {
        ...state,
        status: "connected",
        connected: true,
        error: null,
        reconnectAttempt: 0,
        reconnectMsg: "",
      };

    case "RECONNECT_FAILED":
      guard(["reconnecting"]);
      return {
        ...state,
        status: "error",
        reconnectMsg: "Reconnection failed — refresh the page",
      };

    // ── Network ────────────────────────────────────────────────────
    case "ROUTE":
      return { ...state, route: action.route, routeDetail: action.detail };

    case "SET_RTT":
      return { ...state, rttMs: action.ms };

    case "SET_RTT_ACTIVE":
      return { ...state, rttActive: action.active };

    case "CONNECTED_STEP":
      guard(["connected"]);
      return {
        ...state,
        pipeline: advancePipelineStep(state.pipeline, "connected"),
      };

    default:
      return state;
  }
}

// ── Component ─────────────────────────────────────────────────────────

export default function GamePlayer({
  gameId,
  serverId,
  gameName,
  hostToken,
  joinToken: joinTokenProp,
  onClose,
  sessionId,
  initialPipeline,
  initialStatus: _initialStatus,
}: GamePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<any>(null);
  const searchParams = useSearchParams();
  const joinToken = joinTokenProp || searchParams.get("join") || undefined;

  // ── Connection state machine (useReducer replaces 8 useState hooks)
  const [state, rawDispatch] = useReducer(
    playerReducer,
    initialPipeline,
    initialPlayerState,
  );

  // ── Leak guard: warn if dispatch is called after unmount ─────────
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const dispatch = useCallback(
    (action: PlayerAction) => {
      if (!mountedRef.current) {
        console.warn(
          "[GamePlayer] dispatch after unmount — state leak:",
          action.type,
        );
        return;
      }
      rawDispatch(action);
    },
    [rawDispatch],
  );

  // ── Independent UI toggles (kept as useState — not part of connection lifecycle)
  const [showSlots, setShowSlots] = useState(false);
  const [showRemap, setShowRemap] = useState(false);
  const [remapWaiting, setRemapWaiting] = useState<string | null>(null);
  const [showRoomControls, setShowRoomControls] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);

  // ── One-shot data
  const [roomToken, setRoomToken] = useState<string | null>(null);
  const [saveEntries, setSaveEntries] = useState<any[]>([]);

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
      dispatch({ type: "SET_RTT", ms: playerRef.current.rttMs });
    }
  }, state.rttActive ? RTT_POLL_MS : null);

  // ── "Playing" step — delayed after connected so first frame paints ──
  useEffect(() => {
    if (!state.connected) return;
    const t = setTimeout(() => dispatch({ type: "CONNECTED_STEP" }), 300);
    return () => clearTimeout(t);
  }, [state.connected]);

  // ── Player script ─────────────────────────────────────────────────

  useEffect(() => {
    if (window.gvPlay) {
      dispatch({ type: "SCRIPT_READY" });
    }
  }, []);

  // ── Player init ───────────────────────────────────────────────────

  useEffect(() => {
    if (state.status !== "idle" || !videoRef.current || !serverId) return;
    if (startedRef.current) return;

    const gvPlay = window.gvPlay;
    if (!gvPlay) return;

    startedRef.current = true;
    dispatch({ type: "PLAYER_STARTING" });

    const player = gvPlay.startPlayer(
      videoRef.current,
      serverId,
      gameId,
      null,
      {
        onStateChange(gvState: string, detail?: string) {
          dispatch({ type: "GV_STATE", gvState, detail });
        },
        onStats(_stats: object) {},
        onSaveResult(index: number, ok: boolean, error?: string) {
          showToast(
            ok ? `Saved (#${index})` : `Save failed — ${error || "unknown"}`,
            ok,
          );
        },
        onLoadResult(ok: boolean, error?: string) {
          showToast(
            ok ? "Loaded" : `Load failed — ${error || "unknown"}`,
            ok,
          );
        },
        onListSaves(entries: any[], _nextIndex: number) {
          setSaveEntries(entries || []);
        },
        onError(msg: string) {
          dispatch({ type: "ERROR", msg });
        },
        onProgress(msg: string) {
          dispatch({ type: "PROGRESS", msg });
        },
        onReconnecting(attempt: number) {
          dispatch({ type: "RECONNECTING", attempt });
        },
        onReconnected() {
          dispatch({ type: "RECONNECTED" });
          showToast("Reconnected", true);
        },
        onReconnectFailed() {
          dispatch({ type: "RECONNECT_FAILED" });
        },
        onRoute(routeLabel: string, detail: string) {
          dispatch({ type: "ROUTE", route: routeLabel, detail });
        },
      },
      joinToken,
      hostToken,
    );

    playerRef.current = player;
    dispatch({ type: "SET_RTT_ACTIVE", active: true });

    return () => {
      dispatch({ type: "SET_RTT_ACTIVE", active: false });
    };
  }, [state.status, serverId, gameId, showToast, joinToken, hostToken]);

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
      } catch {
        /* not supported */
      }
    } else {
      await document.exitFullscreen();
    }
  };

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

  // ── Save stack handlers ──────────────────────────────────────────

  const handleSave = () => {
    const gvPlay = window.gvPlay;
    if (!gvPlay || !playerRef.current) {
      showToast("Not connected", false);
      return;
    }
    const ok = gvPlay.saveState(playerRef.current);
    if (!ok) showToast("Not connected", false);
  };

  const handleLoad = () => {
    const gvPlay = window.gvPlay;
    if (!gvPlay || !playerRef.current) {
      showToast("Not connected", false);
      return;
    }
    const ok = gvPlay.loadState(playerRef.current);
    if (!ok) showToast("Not connected", false);
  };

  const handleLoadAt = (index: number) => {
    const gvPlay = window.gvPlay;
    if (!gvPlay || !playerRef.current) {
      showToast("Not connected", false);
      return;
    }
    const ok = gvPlay.loadStateAt(playerRef.current, index);
    if (!ok) showToast("Not connected", false);
    showToast(`Loading #${index}…`, true);
  };

  const handleListSaves = () => {
    const gvPlay = window.gvPlay;
    if (!gvPlay || !playerRef.current) return;
    gvPlay.listSaves(playerRef.current);
  };

  // ── Share ─────────────────────────────────────────────────────────

  const shareUrlSet = useRef(false);

  useEffect(() => {
    if (!state.connected) return;
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
      } catch {
        /* best-effort */
      }
    })();
  }, [state.connected, gameId, serverId, roomToken]);

  // ── Loading text ──────────────────────────────────────────────────

  const loadingText = hostToken
    ? "Reconnecting…"
    : gameName
      ? `Starting ${gameName}`
      : state.statusText;

  // ── Is the pipeline visible? ─────────────────────────────────────
  const showPipeline =
    state.status === "connecting" || state.status === "error";

  const showDisconnect = state.status === "reconnecting";

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div
      className={styles.shell}
      onMouseMove={wakeControls}
      onKeyDown={wakeControls}
    >
      <style>{`
        @keyframes gv-pipeline-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>

      <Script src="/player/touch-gamepad.js" />
      <Script
        src="/player/play.js"
        type="module"
        onLoad={() => dispatch({ type: "SCRIPT_READY" })}
      />

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={styles.video}
      />

      {/* Top bar */}
      <div
        className={styles.topBar}
        style={{
          opacity: state.connected && controlsVisible ? 1 : 0,
          pointerEvents:
            state.connected && controlsVisible ? "auto" : "none",
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
          opacity: state.connected && controlsVisible ? 1 : 0,
          pointerEvents:
            state.connected && controlsVisible ? "auto" : "none",
        }}
      >
        <span className={styles.hint}>
          Arrows = Move &nbsp;|&nbsp; Z = A &nbsp;|&nbsp; X = B
          &nbsp;|&nbsp; Enter = Start
        </span>
        {state.route && (
          <Badge
            variant={routeVariant(state.route)}
            title={state.routeDetail || state.route}
          >
            {state.route}
          </Badge>
        )}
        <div className={styles.bottomRight}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              sendDC({ cmd: "save_state" });
              showToast("Saved", true);
            }}
          >
            💾 Save
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              sendDC({ cmd: "load_state" });
              showToast("Loaded", true);
            }}
          >
            📂 Load
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowRemap(!showRemap)}
          >
            🎮 Keys
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowRoomControls(!showRoomControls)}
          >
            ⚙ Room
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowSlots(!showSlots);
              handleListSaves();
            }}
          >
            💾 Saves
          </Button>
          <Button variant="secondary" size="sm" onClick={toggleFullscreen}>
            {isFullscreen ? "↙" : "⛶"}
          </Button>
        </div>
      </div>

      {/* Pipeline loading */}
      {showPipeline && (
        <div className={styles.centerMessage}>
          <p className={styles.loadingText}>{loadingText}</p>
          <div className={styles.pipeline}>
            {PIPELINE_STEPS.map((step) => {
              const stepState = state.pipeline[step.id] || "pending";
              return (
                <div key={step.id} className={styles.stepRow}>
                  <span
                    className={styles.stepDot}
                    style={{
                      background: dotColor(stepState),
                      animation:
                        stepState === "active"
                          ? "gv-pipeline-pulse 1.2s ease-in-out infinite"
                          : undefined,
                    }}
                  >
                    {dotChar(stepState)}
                  </span>
                  <span
                    className={styles.stepLabel}
                    style={{ color: labelColor(stepState) }}
                  >
                    {step.label}
                  </span>
                  {stepState === "failed" && (
                    <button
                      className={styles.retryBtn}
                      onClick={() => window.location.reload()}
                      title="Retry"
                    >
                      ↻
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {state.error && (
            <div className={styles.errorBox}>
              <p className={styles.pipelineError}>{state.error}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => window.location.reload()}
              >
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
            {state.reconnectAttempt < 5 ? (
              <>
                <p className={styles.overlayTitle}>Connection lost</p>
                <p className={styles.overlaySub}>
                  {state.reconnectMsg || "Reconnecting…"}
                </p>
              </>
            ) : (
              <>
                <p className={styles.overlayTitle}>Reconnection failed</p>
                <p className={styles.overlaySub}>
                  Refresh the page to try again
                </p>
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

      {/* Save stack */}
      {showSlots && (
        <>
          <div
            className={styles.backdrop}
            onClick={() => setShowSlots(false)}
          />
          <div className={styles.slotPanel}>
            <div className={styles.slotHeader}>
              <span>Save Stack</span>
              <Button variant="ghost" onClick={() => setShowSlots(false)}>
                ✕
              </Button>
            </div>
            <div className={styles.roomGrid}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  handleSave();
                  handleListSaves();
                }}
              >
                💾 Save Now
              </Button>
              <Button variant="secondary" size="sm" onClick={handleLoad}>
                📂 Load Latest
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  handleListSaves();
                }}
              >
                ↻ Refresh
              </Button>
            </div>
            {saveEntries.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className={styles.slotHeader}>
                  <span>
                    {saveEntries.length} save
                    {saveEntries.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className={styles.roomGrid} style={{ marginTop: 8 }}>
                  {saveEntries.map((e: any) => (
                    <Button
                      key={`load-${e.index}`}
                      variant="secondary"
                      size="sm"
                      onClick={() => handleLoadAt(e.index)}
                      title={`${e.size} bytes · ${e.timestamp}`}
                    >
                      📂 #{e.index}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {saveEntries.length === 0 && (
              <p
                style={{
                  color: "var(--color-muted)",
                  fontSize: "var(--font-size-sm)",
                  marginTop: 12,
                }}
              >
                No saves yet — press 💾 Save Now
              </p>
            )}
          </div>
        </>
      )}

      {/* Key remap overlay */}
      {showRemap && (
        <>
          <div
            className={styles.backdrop}
            onClick={() => {
              setShowRemap(false);
              setRemapWaiting(null);
            }}
          />
          <RemapPanel
            playerRef={playerRef}
            waiting={remapWaiting}
            setWaiting={setRemapWaiting}
            onClose={() => {
              setShowRemap(false);
              setRemapWaiting(null);
            }}
          />
        </>
      )}

      {/* Room controls overlay */}
      {showRoomControls && (
        <>
          <div
            className={styles.backdrop}
            onClick={() => setShowRoomControls(false)}
          />
          <div className={styles.roomPanel}>
            <div className={styles.slotHeader}>
              <span>Room</span>
              <Button
                variant="ghost"
                onClick={() => setShowRoomControls(false)}
              >
                ✕
              </Button>
            </div>
            <div className={styles.roomGrid}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  sendDC({ cmd: "reset" });
                  showToast("Reset", true);
                }}
              >
                ↺ Reset
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  sendDC({ cmd: "save_state" });
                  showToast("Saved", true);
                }}
              >
                💾 Quick Save
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  sendDC({ cmd: "load_state" });
                  showToast("Loaded", true);
                }}
              >
                📂 Quick Load
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  sendDC({ cmd: "disk_eject" });
                  showToast("Disk ejected", true);
                }}
              >
                💿 Eject
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  sendDC({ cmd: "disk_insert", index: 0 });
                  showToast("Disk 0 inserted", true);
                }}
              >
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
                      () => showToast("Copy failed", false),
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
        <Toast
          variant={toast.ok ? "success" : "error"}
          onDone={() => setToast(null)}
        >
          {toast.text}
        </Toast>
      )}
    </div>
  );
}
