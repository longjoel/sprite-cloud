# Player Pipeline Progress Indicator — Implementation Plan

> **For Hermes:** Execute task-by-task. Commit after each task.

**Goal:** Replace the single "Starting game…" / "connecting…" status line with a left-to-right pipeline showing each connection stage with checkmarks, live progress, and error states with retry.

**Architecture:** A `PipelineProgress` component in `GamePlayer.tsx` renders horizontal steps. Each step has a state: `pending`, `active` (animated), `done` (✔), or `failed` (✖). The existing `onProgress` and `onStateChange` callbacks drive pipeline advancement. No new API calls — we just surface the steps the player already goes through.

**Tech Stack:** React 19, inline CSS (Humidor tokens), no new dependencies

---

## Current state

The player flow (in `play.js` and `GamePlayer.tsx`) goes through these stages implicitly:

| Stage | Where it happens | Visible? |
|-------|-----------------|----------|
| ICE config fetch | `fetchIceConfig()` in play.js | ❌ invisible |
| Start game (POST + poll) | `startGame()` in play.js | Partially — "Starting game…", "Waiting for worker…" |
| SDP handshake (offer/answer) | `connectViaRelay()` in index.js | ❌ invisible |
| ICE gathering + connection | WebRTC internals | ❌ invisible |
| DataChannel open | `_onDataChannelOpen()` in index.js | Via "connected" state change |
| Playing | `State.CONNECTED` | ✓ Visible |
| Error + reconnect | `doReconnect()` in play.js | Via "Connection lost" overlay |

The page.tsx pre-validation (server check, game availability) also has states that aren't surfaced in the pipeline.

## Target pipeline

```
 ICE    →   Server   →   Game    →   Worker   →   Handshake   →   Connect   =   Playing
 ✓          ✓           ✓           ⟳              ○              ○
                                 (spinning)     (waiting)

 Error states:
 ✖ ICE failed    ✖ Offline    ✖ Not found    ✖ Timeout    ✖ Failed    ✖ Failed
   [Retry]         [Retry]      [Retry]        [Retry]       [Retry]     [Retry]
```

Each step transitions: `pending` → `active` → `done` (or `failed` → `retry`)

---

## Task 1: Define pipeline types and component shell

**Objective:** Create the `PipelineProgress` component with step definitions and rendering.

**Files:**
- Modify: `gv-web/components/GamePlayer.tsx`

**Step 1: Add types**

At the top of GamePlayer.tsx, add:

```tsx
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
```

**Step 2: Add state to GamePlayer component**

```tsx
const [pipeline, setPipeline] = useState<Record<string, StepState>>(
  Object.fromEntries(PIPELINE_STEPS.map((s) => [s.id, "pending"]))
);
```

**Step 3: Add pipeline advance helpers**

```tsx
const advanceStep = useCallback((stepId: string) => {
  setPipeline((prev) => ({ ...prev, [stepId]: "done" }));
  // Set the next pending step to active
  const idx = PIPELINE_STEPS.findIndex((s) => s.id === stepId);
  if (idx >= 0 && idx < PIPELINE_STEPS.length - 1) {
    const nextId = PIPELINE_STEPS[idx + 1].id;
    setPipeline((prev) => ({ ...prev, [nextId]: "active" }));
  }
}, []);

const failStep = useCallback((stepId: string) => {
  setPipeline((prev) => ({ ...prev, [stepId]: "failed" }));
}, []);
```

**Step 4: Add PipelineProgress component rendering**

Replace the current connecting overlay (lines 391-398) with:

```tsx
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
            <span style={{
              ...styles.stepDot,
              background: state === "done" ? "var(--color-success)" :
                          state === "failed" ? "var(--color-error)" :
                          state === "active" ? "var(--color-brass)" :
                          "var(--color-walnut)",
            }}>
              {state === "done" ? "✓" : state === "failed" ? "✖" : state === "active" ? "●" : "○"}
            </span>
            <span style={{
              ...styles.stepLabel,
              color: state === "active" ? "var(--color-cream)" :
                     state === "failed" ? "var(--color-error)" :
                     state === "done" ? "var(--color-success)" :
                     "var(--color-muted)",
            }}>
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
    {error && (
      <div style={styles.errorBox}>
        <p style={styles.errorText}>{error}</p>
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    )}
  </div>
)}
```

**Acceptance:**
- Pipeline steps render in a vertical column during loading
- Each step shows dot + label with appropriate colors
- `pnpm build` passes
- Git commit

---

## Task 2: Wire pipeline advancement from play.js callbacks

**Objective:** The `onProgress` and `onStateChange` callbacks in `play.js` now advance the pipeline through each stage.

**Files:**
- Modify: `gv-web/components/GamePlayer.tsx`
- Modify: `gv-web/public/player/play.js`

**Step 1: Add granular onProgress calls in play.js**

In `startGame()` (play.js line 79-128), add more progress callbacks:

```js
// In startGame():
callbacks?.onProgress?.("Starting game…");         // → advance "game"
// After POST succeeds:
callbacks?.onProgress?.("Worker starting…");       // → advance "worker"  
// After worker URL received:
callbacks?.onProgress?.("Worker ready");            // → already implied
```

In `startPlayer()` / `doConnect()`:

```js
callbacks.onStateChange?.("connecting");            // → advance "handshake" to active
// After startGame succeeds:
callbacks?.onProgress?.("handshaking");             // → advance "handshake" to active (duplicate guard)
// After connectViaRelay succeeds, state machine fires CONNECTED
```

**Step 2: Wire onProgress → pipeline in GamePlayer.tsx**

In the `onProgress` callback (line 183-185), replace the simple `setStatus(msg)`:

```tsx
onProgress(msg: string) {
  setStatus(msg);
  // Map progress messages to pipeline steps
  if (msg.includes("Starting game")) advanceStep("game");
  else if (msg.includes("Worker")) advanceStep("worker");
  else if (msg.includes("handshak")) advanceStep("handshake");
}
```

**Step 3: Wire onStateChange → pipeline**

In `onStateChange` (lines 158-172):

```tsx
onStateChange(state: string, detail?: string) {
  setStatus(state);
  if (state === "connecting") {
    // Already handled by onProgress, but belt-and-suspenders
    advanceStep("handshake");
  }
  if (state === "connected") {
    advanceStep("connected");
    setError(null);
    setConnected(true);
    setShowDisconnect(false);
  }
  if (state === "error") {
    // Find the current active step and mark it failed
    const failedStep = PIPELINE_STEPS.find(s => pipeline[s.id] === "active");
    if (failedStep) failStep(failedStep.id);
    setError(detail ?? "connection error");
    setConnected(false);
  }
},
```

**Step 4: Handle page.tsx pre-validation stages**

In `gv-web/app/play/[game_id]/page.tsx`, the server validation (lines 63-82) checks server availability and game existence. These happen BEFORE GamePlayer renders. To surface these in the pipeline, we need to pass initial pipeline state to GamePlayer.

Add an `initialPipeline` prop:

```tsx
// In page.tsx: after validation passes, set initial pipeline state
<GamePlayer
  gameId={gameId}
  serverId={resolvedServerId}
  initialPipeline={{ ice: "done", server: "done", game: "done" }}
  onClose={() => router.push("/")}
/>
```

GamePlayer initializes its pipeline state from this prop:

```tsx
const [pipeline, setPipeline] = useState<Record<string, StepState>>(
  initialPipeline ?? Object.fromEntries(PIPELINE_STEPS.map((s) => [s.id, "pending"]))
);
```

Also in page.tsx, when server validation fails, show a mini-pipeline with the failed step instead of just the error text:

```tsx
// Replace the simple error text with a pipeline showing where it failed
{serverError && (
  <main style={{ ...styles.shell, background: "var(--color-mahogany)" }}>
    <PipelineError
      steps={{ ice: "done", server: serverError.includes("offline") ? "failed" : "done", 
              game: serverError.includes("not available") ? "failed" : "pending" }}
      error={serverError}
      gameId={gameId}
    />
  </main>
)}
```

Actually, this is getting complex. Let me simplify — Task 2 is already big enough. The page.tsx validation can be a separate task.

**Acceptance:**
- Pipeline advances through stages during connection
- Error state marks the failed step
- `pnpm build` passes
- Git commit

---

## Task 3: Polish — animations, error recovery, mobile

**Objective:** Add CSS animation for active step, proper error retry, and mobile layout.

**Files:**
- Modify: `gv-web/components/GamePlayer.tsx`

**Step 1: Active step animation**

Add a pulsing animation to the active step dot:

```tsx
// In styles:
"@keyframes pulse": {
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.4 },
},
stepDot: {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  borderRadius: "50%",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  marginRight: "var(--space-3)",
  flexShrink: 0,
},
```

For the active state, use a CSS animation via inline style with `animation` property:

```tsx
style={{
  ...styles.stepDot,
  animation: state === "active" ? "pulse 1.2s ease-in-out infinite" : undefined,
  ...
}}
```

Actually, inline styles can't use `@keyframes`. Use a CSS class or a `<style>` tag. Simplest: inject a `<style>` tag with the keyframes inside the component.

**Step 2: Error retry button per failed step**

When a step fails, show a small "Retry" button next to it:

```tsx
{state === "failed" && (
  <button
    style={styles.retryBtn}
    onClick={() => {
      setPipeline((prev) => ({ ...prev, [step.id]: "active" }));
      setError(null);
      // Trigger reconnect from the failed stage
      // Need to expose a retryFrom callback
    }}
  >
    ↻
  </button>
)}
```

**Step 3: Mobile layout**

On narrow screens, the pipeline should be more compact:

```tsx
pipeline: {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  marginTop: "var(--space-6)",
},
```

This already works. Add a media query for very small screens to reduce spacing.

**Acceptance:**
- Active step pulses
- Failed step shows retry button  
- Pipeline renders cleanly on mobile
- `pnpm build` passes
- Git commit

---

## Task 4: Surface page.tsx pre-validation in pipeline

**Objective:** The server-check and game-availability checks in `page.tsx` pass their results into the pipeline so the user sees where validation failed.

**Files:**
- Modify: `gv-web/app/play/[game_id]/page.tsx`
- Modify: `gv-web/components/GamePlayer.tsx`

**Step 1: Add initialPipeline prop to GamePlayer**

```tsx
interface GamePlayerProps {
  gameId: string;
  serverId: string;
  gameName?: string;
  onClose?: () => void;
  sessionId?: string;
  initialPipeline?: Record<string, StepState>;
}
```

**Step 2: Initialize pipeline from prop**

```tsx
export default function GamePlayer({ ..., initialPipeline }: GamePlayerProps) {
  const [pipeline, setPipeline] = useState<Record<string, StepState>>(
    initialPipeline ?? 
    Object.fromEntries(PIPELINE_STEPS.map((s) => [s.id, s.id === "ice" ? "active" : "pending"]))
  );
```

**Step 3: Pass initial state from page.tsx**

When validation passes:
```tsx
<GamePlayer
  gameId={gameId}
  serverId={resolvedServerId}
  initialPipeline={{ ice: "done", server: "done", game: "done", worker: "active" }}
  onClose={() => router.push("/")}
/>
```

**Step 4: Surface validation failure as pipeline error**

Replace the simple `serverError` text page (lines 209-220) with a small pipeline view showing which step failed:

```tsx
if (serverError) {
  const steps: Record<string, StepState> = {
    ice: "done",
    server: serverError.includes("offline") || serverError.includes("not found") ? "failed" : "done",
    game: serverError.includes("not available") ? "failed" : "pending",
    worker: "pending",
    handshake: "pending",
    connected: "pending",
  };
  return (
    <main style={{ ...styles.shell, background: "var(--color-mahogany)" }}>
      <div style={styles.center}>
        <p style={styles.text}>Could not start game</p>
        <div style={pipelineStyles}>
          {PIPELINE_STEPS.map((step) => {
            const state = steps[step.id] || "pending";
            return (
              <div key={step.id} style={stepRowStyle}>
                <span style={dotStyle(state)}>
                  {state === "done" ? "✓" : state === "failed" ? "✖" : "○"}
                </span>
                <span style={labelStyle(state)}>{step.label}</span>
              </div>
            );
          })}
        </div>
        <p style={{ ...styles.hint, color: "var(--color-error)", marginTop: "var(--space-4)" }}>
          {serverError}
        </p>
        <a href="/" style={styles.hint}>← Back to Library</a>
      </div>
    </main>
  );
}
```

**Acceptance:**
- When server is offline, pipeline shows ICE ✓, Server ✖
- When game not found, pipeline shows ICE ✓, Server ✓, Game ✖
- When all good, GamePlayer starts with first 4 steps already done
- `pnpm build` passes
- Git commit

---

## Task 5: Ship — build, deploy, smoke test

**Objective:** Build, deploy web, verify the pipeline renders on a live game launch.

```bash
cd gv-web && pnpm build
git add -A
git commit -m "feat: player pipeline progress indicator"
git push origin main
./scripts/deploy-vps-web.sh
./scripts/smoke-test.sh
```

**Acceptance:**
- `pnpm build` passes
- Deploy succeeds
- Smoke test passes
- Launch a game and see the pipeline animate through stages
