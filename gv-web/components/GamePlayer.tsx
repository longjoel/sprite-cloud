"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useInterval } from "@/lib/poll";
import { Button, Toast } from "@/components/ui";
import RemapPanel from "./GamePlayerRemapPanel";
import OptionsOverlay from "./OptionsOverlay";
import {
  backPlayerPanel,
  blockPlayerPanels,
  closePlayerPanel,
  INITIAL_PLAYER_OVERLAY_STATE,
  openPlayerPanel,
  releaseVisibleTouchGamepad,
  type PlayerPanel,
} from "@/lib/ui/player-overlay-state";
import styles from "./GamePlayer.module.css";
import {
  type StepState,
  PIPELINE_STEPS,
  defaultPipeline,
  mergePipeline,
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
    __gvTouchGamepad?: {
      toggle: () => void;
      isVisible: () => boolean;
      setPreset: (preset: string) => void;
      show: () => void;
      hide: () => void;
      suspendInput: () => void;
      resumeInput: () => void;
      enterEditMode: () => void;
      swapAB: () => void;
    };
    __gvPlayer?: any; // GvPlayer instance for XMB quick menu
  }
}

// ── Props ─────────────────────────────────────────────────────────────

interface GamePlayerProps {
  gameId: string;
  serverId: string;
  gameName?: string;
  platform?: string;        // platform name for gamepad preset
  hostToken?: string;       // pre-existing host token for reconnection
  joinToken?: string;       // pre-existing room token for guest join
  shortCode?: string;       // pre-existing short code (LAN proxy pass-through)
  onClose?: () => void;
  onConnected?: () => void; // fired when WebRTC connects
  onFatalError?: (msg: string) => void; // fired on connection failure — page can show error screen
  sessionId?: string;
  initialPipeline?: Record<string, StepState>;
  initialStatus?: string;
  hidePipeline?: boolean;   // suppress internal pipeline loading (page has its own overlay)
  onPipelineChange?: (pipeline: Record<string, StepState>) => void;
}

// ── Component ─────────────────────────────────────────────────────────

export default function GamePlayer({
  gameId,
  serverId,
  gameName,
  platform,
  hostToken,
  joinToken: joinTokenProp,
  shortCode: shortCodeProp,
  onClose,
  onConnected,
  onFatalError,
  sessionId,
  initialPipeline,
  initialStatus,
  hidePipeline,
  onPipelineChange,
}: GamePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<any>(null);
  const searchParams = useSearchParams();
  const joinToken = joinTokenProp || searchParams.get("join") || undefined;

  const [status, setStatus] = useState("loading…");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [overlayState, setOverlayState] = useState(INITIAL_PLAYER_OVERLAY_STATE);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [audioMuted, setAudioMuted] = useState(true);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [reconnectMsg, setReconnectMsg] = useState("");
  const [toast, setToast] = useState<ToastData | null>(null);
  const [route, setRoute] = useState<string | null>(null);
  const [routeDetail, setRouteDetail] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);
  const [rttActive, setRttActive] = useState(false);
  const [roomToken, setRoomToken] = useState<string | null>(null);
  const [remapWaiting, setRemapWaiting] = useState<string | null>(null);
  const [statsData, setStatsData] = useState<Record<string, any>>({ video: {}, audio: {}, pipeline: {} });
  const [snapshotFlash, setSnapshotFlash] = useState(false);
  const [touchGamepadVisible, setTouchGamepadVisible] = useState(() => {
    // Hide by default on desktop (non-touch), show on mobile
    try {
      const saved = localStorage.getItem('gv:touch-visible');
      if (saved !== null) return saved !== '0';
      // Only auto-show on touch-first devices (phone/tablet, not desktop with touch monitor)
      const hasTouch = typeof window !== 'undefined' && 'ontouchstart' in window;
      return hasTouch && window.matchMedia('(pointer: coarse)').matches;
    } catch { return false; }
  });

  const [pipeline, setPipeline] = useState<Record<string, StepState>>(
    () => mergePipeline(defaultPipeline(), initialPipeline),
  );

  // ── Mobile detection & cast mode ──────────────────────────────────
  const [isMobile, setIsMobile] = useState(false);
  const [castMode, setCastMode] = useState(false);
  const optionsTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const check = () => {
      const touch = typeof window !== "undefined" && "ontouchstart" in window;
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      const small = window.innerWidth < 768 || window.innerHeight < 768;
      setIsMobile(Boolean(touch && (coarse || small)));
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // When cast mode is on, expand gamepad to full screen + hide video
  useEffect(() => {
    const tg = window.__gvTouchGamepad;
    if (!tg) return;
    if (castMode) {
      // Force gamepad visible
      if (!tg.isVisible?.()) tg.show?.();
      setTouchGamepadVisible(true);
      // Make gamepad canvas full-screen (overrides the library's resize)
      const canvas = (tg as any)._canvas;
      if (canvas) {
        canvas.style.position = "fixed";
        canvas.style.inset = "0";
        canvas.style.width = "100vw";
        canvas.style.height = "100vh";
        canvas.style.zIndex = "20";
      }
    }
  }, [castMode]);

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false);

  // ── Notify parent when pipeline changes ────────────────────────────
  useEffect(() => {
    onPipelineChange?.(pipeline);
  }, [pipeline, onPipelineChange]);

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

    const player = (() => {
      if (typeof RTCPeerConnection === "undefined") {
        const msg = "WebRTC unavailable — your browser or network may block it";
        setError(msg);
        onFatalError?.(msg);
        return null;
      }
      try {
        return gvPlay.startPlayer(
          videoRef.current,
          serverId,
          gameId,
          null,
          {
            onStateChange(state: string, detail?: string) {
              setStatus(state);
              if (state === "connecting") {
                advanceStep("server");
              }
              if (state === "connected") {
                advanceStep("media");
                setTimeout(() => advanceStep("connected"), 300);
                setError(null);
                setConnected(true);
                onConnected?.();
                setShowDisconnect(false);
              }
              if (state === "error") {
                const activeStep = PIPELINE_STEPS.find(
                  (s) => pipeline[s.id] === "active",
                );
                if (activeStep) failStep(activeStep.id);
                setError(detail ?? "connection error");
                setConnected(false);
                setShowDisconnect(false);
              }
              if (state === "idle") {
                setConnected(false);
              }
            },
            onStats(stats: object) {
              setStatsData(stats as Record<string, any>);
            },
            onSaveResult(index: number, ok: boolean, error?: string) {
              showToast(
                ok ? `Saved (#${index})` : `Save failed — ${error || "unknown"}`,
                ok,
              );
            },
            onLoadResult(ok: boolean, error?: string) {
              showToast(ok ? "Loaded" : `Load failed — ${error || "unknown"}`, ok);
            },
            onListSaves(_entries: any[], _nextIndex: number) {},
            onError(msg: string) {
              setError(msg);
              setShowDisconnect(false);
              onFatalError?.(msg);
              const activeStep = PIPELINE_STEPS.find(
                (s) => pipeline[s.id] === "active",
              );
              if (activeStep) failStep(activeStep.id);
            },
            onProgress(_msg: string) {},
            onReconnecting(_attempt: number) {},
            onReconnected() {
              setShowDisconnect(false);
              setError(null);
            },
            onReconnectFailed() {
              if (hidePipeline) {
                setShowDisconnect(false);
                onFatalError?.("Reconnection failed — the host may have stopped streaming");
              }
            },
            onRoute(routeLabel: string, detail: string) {
              setRoute(routeLabel);
              setRouteDetail(detail);
            },
          },
          joinToken,
          hostToken,
        );
      } catch (e: any) {
        const msg = e?.message || String(e);
        setError(msg);
        onFatalError?.(msg);
        return null;
      }
    })();

    if (!player) return;
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

  // ── Touch gamepad toggle ─────────────────────────────────────────

  const toggleTouchGamepad = useCallback(() => {
    const tg = window.__gvTouchGamepad;
    if (!tg) return;
    // Use React state as source of truth — tg.isVisible() gets out of sync
    if (touchGamepadVisible) {
      tg.hide();
      setTouchGamepadVisible(false);
      try { localStorage.setItem('gv:touch-visible', '0'); } catch {}
    } else {
      tg.show();
      setTouchGamepadVisible(true);
      try { localStorage.setItem('gv:touch-visible', '1'); } catch {}
    }
  }, [touchGamepadVisible]);

  const openPanel = useCallback((panel: PlayerPanel) => {
    setOverlayState((state) => openPlayerPanel(state, panel));
  }, []);

  const closePanel = useCallback(() => {
    setOverlayState((state) => closePlayerPanel(state));
    setRemapWaiting(null);
    requestAnimationFrame(() => optionsTriggerRef.current?.focus());
  }, []);

  const handleBack = useCallback(() => {
    if (overlayState.activePanel === "none") {
      onClose?.();
      return;
    }
    if (overlayState.activePanel === "options") {
      closePanel();
      return;
    }
    setOverlayState((state) => backPlayerPanel(state));
    setRemapWaiting(null);
  }, [closePanel, onClose, overlayState.activePanel]);

  const blockingPanelOpen = overlayState.activePanel !== "none" || showDisconnect || Boolean(error);
  const higherPriorityBlocking = showDisconnect || Boolean(error);

  useEffect(() => {
    const touchGamepad = window.__gvTouchGamepad;
    if (blockingPanelOpen) {
      releaseVisibleTouchGamepad(touchGamepad, touchGamepadVisible);
    } else {
      touchGamepad?.resumeInput();
    }
  }, [blockingPanelOpen, touchGamepadVisible]);

  useEffect(() => {
    if (!higherPriorityBlocking) return;
    setOverlayState((state) => blockPlayerPanels(state));
    setRemapWaiting(null);
  }, [higherPriorityBlocking]);

  useEffect(() => {
    if (higherPriorityBlocking || overlayState.activePanel === "none") return;
    const panel = document.querySelector<HTMLElement>("[data-player-panel]");
    if (!panel) return;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    (focusable()[0] ?? panel).focus();
    const trapPanelFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) { event.preventDefault(); panel.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    panel.addEventListener("keydown", trapPanelFocus);
    return () => panel.removeEventListener("keydown", trapPanelFocus);
  }, [higherPriorityBlocking, overlayState.activePanel]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || higherPriorityBlocking || overlayState.activePanel === "none") return;
      event.preventDefault();
      closePanel();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closePanel, higherPriorityBlocking, overlayState.activePanel]);

  // Set video dataset attributes for touch-gamepad.js to read
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !connected) return;
    // Map platform name to gamepad preset
    const presetMap: Record<string, string> = {
      'NES': 'nes', 'SNES': 'snes', 'Game Boy': 'nes', 'Game Boy Color': 'nes',
      'Game Boy Advance': 'nes', 'Family Computer Disk System': 'nes',
      'Virtual Boy': 'nes', 'Pokemon Mini': 'nes', 'WonderSwan': 'nes',
      'WonderSwan Color': 'nes', 'Neo Geo Pocket': 'nes', 'Neo Geo Pocket Color': 'nes',
      'Nintendo 64': 'nes', 'Nintendo DS': 'nes',
      'Genesis': 'genesis', 'Master System': 'genesis', 'Game Gear': 'genesis',
      'Sega CD': 'genesis', 'Sega 32X': 'genesis', 'Saturn': 'genesis', 'Dreamcast': 'genesis',
      'Atari 2600': 'atari', 'Atari 5200': 'atari', 'Atari 7800': 'atari', 'Atari Lynx': 'atari',
      'Arcade': 'arcade', 'Neo Geo CD': 'arcade',
      'PlayStation': 'nes', 'PSP': 'nes', 'PC Engine': 'nes',
    };
    v.dataset.gvPreset = presetMap[platform || ''] || 'nes';
    v.dataset.gvLayout = 'auto';
  }, [connected, platform]);

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

  // ── Save stack ────────────────────────────────────────────────────

  const [saveEntries, setSaveEntries] = useState<any[]>([]);

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

  // ── Snapshot ──────────────────────────────────────────────────────

  const handleSnapshot = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      showToast("Video not ready", false);
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      // Download
      const a = document.createElement("a");
      a.href = dataUrl;
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.download = `sprite-cloud-${ts}.png`;
      a.click();
      showToast("Snapshot saved", true);
    } catch (e: any) {
      showToast("Snapshot failed: " + (e?.message || "unknown"), false);
    }
  }, [showToast]);

  // ── Reposition / Reset controllers ────────────────────────────────

  const handleReposition = useCallback(() => {
    const tg = window.__gvTouchGamepad;
    if (!tg) {
      // Auto-show gamepad first, then enter edit mode
      showToast("Show gamepad first — tap 🎮 in Keys", false);
      return;
    }
    if (!tg.isVisible()) tg.show();
    setTouchGamepadVisible(true);
    setTimeout(() => tg.enterEditMode?.(), 150);
  }, [showToast]);

  const handleResetPosition = useCallback(() => {
    try {
      localStorage.removeItem("gv:touch-layouts-v2");
      showToast("Controller layout reset", true);
    } catch { /* noop */ }
    // Reload layout in gamepad
    const tg = window.__gvTouchGamepad;
    if (tg?.isVisible()) {
      tg.hide();
      setTimeout(() => tg.show(), 100);
    }
  }, [showToast]);

  // ── Cast mode ─────────────────────────────────────────────────────

  const handleCast = useCallback(() => {
    setCastMode(true);
    closePanel();
  }, [closePanel]);

  const handleQrCode = useCallback(() => {
    openPanel("share");
  }, [openPanel]);

  // ── Restart game ──────────────────────────────────────────────────

  const handleRestart = useCallback(() => {
    sendDC({ cmd: "reset" });
    showToast("Restarting…", true);
  }, [sendDC, showToast]);

  // ── Share ─────────────────────────────────────────────────────────

  const [shortCode, setShortCode] = useState<string | null>(shortCodeProp ?? null);

  useEffect(() => {
    if (!connected) return;
    if (shortCodeProp) return; // already provided via props (LAN pass-through)
    if (roomToken) return;
    if (shortCode) return; // already set
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

        // Create a short code for the share link
        const scResp = await fetch("/api/room/shorten", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            game_id: gameId,
            host_token: hostToken || crypto.randomUUID(),
            server_id: serverId,
          }),
        });
        if (scResp.ok) {
          const scData = await scResp.json();
          setShortCode(scData.code);
        }
      } catch { /* best-effort */ }
    })();
  }, [connected, gameId, serverId, hostToken, roomToken]);

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className={styles.shell} onMouseMove={wakeControls} onKeyDown={wakeControls}>
      <style>{`
        @keyframes gv-pipeline-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>

      <Script src="/player/touch-gamepad-v2.js" />
      {/* Canonical browser player bootstrap path. Standalone legacy harness removed. */}
      <Script src="/player/play-v2.js" type="module" onLoad={() => setScriptReady(true)} />

      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={audioMuted}
        className={styles.video}
        style={castMode ? { display: "none" } : undefined}
      />

      {/* Top bar */}
      <div
        className={styles.topBar}
        style={{
          opacity: connected && controlsVisible ? 1 : 0,
          pointerEvents: connected && controlsVisible ? "auto" : "none",
        }}
      >
        <span className={styles.gameTitle}>{gameName || gameId}</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {(
            <Button variant="secondary" size="md" onClick={() => { setAudioMuted((v) => !v); }}>
              {audioMuted ? "🔇" : "🔊"}
            </Button>
          )}
          {(onClose || overlayState.activePanel !== "none") && (
            <Button variant="secondary" size="md" onClick={handleBack}>
              ← Back
            </Button>
          )}
        </div>
      </div>

      {/* Persistent game info chip — always visible while connected */}
      {connected && (gameName || platform) && (
        <div className={styles.gameInfo}>
          {gameName && <span className={styles.gameInfoName}>{gameName}</span>}
          {platform && <span className={styles.gameInfoBadge}>{platform}</span>}
        </div>
      )}

      {/* Options toggle + overlay — replaces old bottom bar */}
      {connected && (
        <OptionsOverlay
          visible={!higherPriorityBlocking && overlayState.activePanel === "options"}
          onToggle={() => overlayState.activePanel === "options" ? closePanel() : openPanel("options")}
          triggerRef={optionsTriggerRef}
          triggerDisabled={overlayState.activePanel !== "none" || higherPriorityBlocking}
          onSave={() => { sendDC({ cmd: "save_state" }); showToast("Saved", true); }}
          onLoad={() => { sendDC({ cmd: "load_state" }); showToast("Loaded", true); }}
          onSnapshot={handleSnapshot}
          onFullscreen={toggleFullscreen}
          isFullscreen={isFullscreen}
          onReposition={handleReposition}
          onResetPosition={handleResetPosition}
          onRestart={handleRestart}
          onOpenSaves={() => { openPanel("saves"); handleListSaves(); }}
          onOpenKeys={() => openPanel("keys")}
          onOpenRoom={() => openPanel("room")}
          onCast={handleCast}
          onQrCode={handleQrCode}
          onStats={() => openPanel("stats")}
          isMobile={isMobile}
        />
      )}

      {/* Stats for Nerds overlay */}
      {!higherPriorityBlocking && overlayState.activePanel === "stats" && (
        <div
          className={styles.overlay}
          style={{ zIndex: 35 }}
          onClick={closePanel}
        >
          <div
            className={styles.overlayPanel}
            style={{ maxWidth: 420, fontSize: 11, fontFamily: "monospace", padding: 16 }}
            onClick={(e) => e.stopPropagation()}
            data-player-panel role="dialog" aria-modal="true" aria-label="Stats for Nerds" tabIndex={-1}
          >
            <Button variant="ghost" size="sm" onClick={() => openPanel("options")}>← Options</Button>
            <p className={styles.overlayTitle}>Stats for Nerds</p>
            {Object.entries(statsData).map(([section, data]) =>
              data && typeof data === "object" && Object.keys(data as object).length > 0 ? (
                <div key={section} style={{ marginTop: 8 }}>
                  <strong style={{ color: "var(--color-accent)", textTransform: "uppercase", fontSize: 10 }}>
                    {section}
                  </strong>
                  <pre style={{ margin: "4px 0 0", font: "inherit", color: "var(--color-text-dim)" }}>
                    {Object.entries(data as object)
                      .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toFixed(1) : v}`)
                      .join("\n")}
                  </pre>
                </div>
              ) : null
            )}
            {Object.values(statsData).every(
              (d) => !d || typeof d !== "object" || Object.keys(d as object).length === 0
            ) && (
              <p style={{ color: "var(--color-text-dim)", marginTop: 8 }}>
                Waiting for stats from server…
              </p>
            )}
          </div>
        </div>
      )}

      {/* Pipeline loading — suppressed when page has its own overlay */}
      {!hidePipeline && !connected && !showDisconnect && (
        <div className={styles.centerMessage}>
          <p className={styles.loadingText}>
            {hostToken ? "Reconnecting\u2026" : gameName ? `Starting ${gameName}` : "Starting game"}
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

      {/* Error shown even when pipeline is hidden (guest / shared link path).
           Only show if there's no onFatalError handler — when the page provides one,
           the page owns the error display; GamePlayer should stay silent. */}
      {error && hidePipeline && !connected && !onFatalError && (
        <div className={styles.overlay} style={{ zIndex: 30 }}>
          <div className={styles.overlayPanel}>
            <p className={styles.overlayTitle}>Connection failed</p>
            <p className={styles.overlaySub} style={{ fontFamily: "monospace", fontSize: 11, wordBreak: "break-all", maxWidth: 320, margin: "12px auto" }}>
              {error}
            </p>
            <div style={{ display: "flex", gap: "var(--space-3)", justifyContent: "center", marginTop: "var(--space-4)" }}>
              <Button variant="secondary" onClick={() => onClose?.()}>← Home</Button>
              <Button variant="primary" onClick={() => window.location.reload()}>↻ Retry</Button>
            </div>
          </div>
        </div>
      )}

      {/* Disconnect overlay — only when reconnecting, not when there's a hard error */}
      {showDisconnect && !error && (
        <div className={styles.overlay}>
          <div className={styles.overlayPanel}>
            {reconnectAttempt < 3 ? (
              <>
                <p className={styles.overlayTitle}>Connection lost</p>
                <p className={styles.overlaySub}>{reconnectMsg || "Reconnecting…"}</p>
              </>
            ) : (
              <>
                <p className={styles.overlayTitle}>Reconnection failed</p>
                <p className={styles.overlaySub}>What would you like to do?</p>
                <div style={{ display: "flex", gap: "var(--space-3)", justifyContent: "center", marginTop: "var(--space-5)" }}>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      onClose?.();
                    }}
                  >
                    ← Abort
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => window.location.reload()}
                  >
                    ↻ Retry
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      // Kill the current session, then reload to start fresh
                      try {
                        await fetch("/api/server/command", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            server_id: serverId,
                            type: "stop_game",
                            payload: { game_id: gameId },
                          }),
                        });
                      } catch { /* best-effort */ }
                      window.location.reload();
                    }}
                  >
                    ✕ Fail
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Save stack */}
      {!higherPriorityBlocking && overlayState.activePanel === "saves" && (
        <>
          <div className={styles.backdrop} onClick={closePanel} />
          <div className={styles.slotPanel} data-player-panel role="dialog" aria-modal="true" aria-label="Save Stack" tabIndex={-1}>
            <div className={styles.slotHeader}>
              <span>Save Stack</span>
              <Button variant="ghost" size="sm" onClick={() => openPanel("options")}>← Options</Button>
              <Button variant="ghost" onClick={closePanel}>✕</Button>
            </div>
            <div className={styles.roomGrid}>
              <Button variant="secondary" size="sm" onClick={() => { handleSave(); handleListSaves(); }}>
                💾 Save Now
              </Button>
              <Button variant="secondary" size="sm" onClick={handleLoad}>
                📂 Load Latest
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { handleListSaves(); }}>
                ↻ Refresh
              </Button>
            </div>
            {saveEntries.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className={styles.slotHeader}>
                  <span>{saveEntries.length} save{saveEntries.length !== 1 ? "s" : ""}</span>
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
              <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", marginTop: 12 }}>
                No saves yet — press 💾 Save Now
              </p>
            )}
          </div>
        </>
      )}

      {/* Key remap overlay */}
      {!higherPriorityBlocking && overlayState.activePanel === "keys" && (
        <>
          <div className={styles.backdrop} onClick={closePanel} />
          <div data-player-panel role="dialog" aria-modal="true" aria-label="Key remapping" tabIndex={-1}>
          <RemapPanel
            playerRef={playerRef}
            waiting={remapWaiting}
            setWaiting={setRemapWaiting}
            onClose={closePanel}
            onBack={() => openPanel("options")}
          />
          </div>
        </>
      )}

      {/* Room controls overlay */}
      {!higherPriorityBlocking && overlayState.activePanel === "room" && (
        <>
          <div className={styles.backdrop} onClick={closePanel} />
          <div className={styles.roomPanel} data-player-panel role="dialog" aria-modal="true" aria-label="Room controls" tabIndex={-1}>
            <div className={styles.slotHeader}>
              <span>Room</span>
              <Button variant="ghost" size="sm" onClick={() => openPanel("options")}>← Options</Button>
              <Button variant="ghost" onClick={closePanel}>✕</Button>
            </div>
            <div className={styles.roomGrid}>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "reset" }); showToast("Reset", true); }}>
                ↺ Reset
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "disk_eject" }); showToast("Disk ejected", true); }}>
                💿 Eject
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { sendDC({ cmd: "disk_insert", index: 0 }); showToast("Disk 0 inserted", true); }}>
                💿 Insert 0
              </Button>
              <Button variant="secondary" size="sm" onClick={toggleTouchGamepad}>
                {touchGamepadVisible ? "🎮 Hide Pad" : "🎮 Show Pad"}
              </Button>
              {shortCode && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const url = `${window.location.origin}/p/${shortCode}?join`;
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

      {/* QR Code overlay */}
      {!higherPriorityBlocking && overlayState.activePanel === "share" && (
        <>
          <div className={styles.backdrop} onClick={closePanel} />
          <div className={styles.roomPanel} data-player-panel role="dialog" aria-modal="true" aria-label="Scan to Join" tabIndex={-1}>
            <div className={styles.slotHeader}>
              <span>Scan to Join</span>
              <Button variant="ghost" size="sm" onClick={() => openPanel("options")}>← Options</Button>
              <Button variant="ghost" onClick={closePanel}>✕</Button>
            </div>
            {shortCode ? (<>
            <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-5)" }}>
              {(() => {
                const qrOrigin = shortCodeProp ? "https://lngnckr.tech" : window.location.origin;
                const qrUrl = `${qrOrigin}/p/${shortCode}?join`;
                return (
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}`}
                    alt="QR Code to join game"
                    style={{ borderRadius: 4, background: "#fff", padding: 8 }}
                  />
                );
              })()}
            </div>
            <p style={{
              color: "var(--color-muted)",
              textAlign: "center",
              fontSize: "var(--font-size-sm)",
              wordBreak: "break-all",
              padding: "0 var(--space-4)",
            }}>
              {(shortCodeProp ? "https://lngnckr.tech" : window.location.origin)}/p/{shortCode}?join
            </p>
            </>
            ) : (
              <p style={{ color: "var(--color-muted)", textAlign: "center", padding: "var(--space-5)" }}>
                Preparing share code…
              </p>
            )}
          </div>
        </>
      )}

      {/* Cast mode chip — shows when casting, tap to exit */}
      {castMode && (
        <div style={{
          position: "fixed",
          top: 12,
          right: 12,
          zIndex: 30,
          display: "flex",
          gap: 8,
        }}>
          <button
            onClick={() => openPanel("share")}
            style={{
              background: "rgba(17, 24, 39, 0.92)",
              border: "1px solid rgba(56, 189, 248, 0.3)",
              borderRadius: 2,
              color: "#e5e7eb",
              padding: "8px 14px",
              fontSize: "var(--font-size-sm)",
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
            }}
          >
            📱 Show QR
          </button>
          <button
            onClick={() => setCastMode(false)}
            style={{
              background: "rgba(248, 113, 113, 0.18)",
              border: "1px solid rgba(248, 113, 113, 0.35)",
              borderRadius: 2,
              color: "#e5e7eb",
              padding: "8px 14px",
              fontSize: "var(--font-size-sm)",
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
            }}
          >
            ✕ Exit Cast
          </button>
        </div>
      )}

      {toast && (
        <Toast variant={toast.ok ? "success" : "error"} onDone={() => setToast(null)}>
          {toast.text}
        </Toast>
      )}
    </div>
  );
}
