import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Regression for core-crash auto-relaunch: when an emulator core dies
// unexpectedly (crash or stall), the player must relaunch the WHOLE session
// (fresh start_game) instead of quietly dead-ending or showing a terminal
// fatal overlay. This test asserts the source-level contract on the vanilla
// player files, matching the repo's established player-file test pattern.
describe("core-crash auto-relaunch", () => {
  const playerSource = readFileSync(resolve(process.cwd(), "public/player/sc-player.js"), "utf8");
  const bootstrapSource = readFileSync(resolve(process.cwd(), "public/player/play-v2.js"), "utf8");

  it("routes core_died to a dedicated recoverable path, not the fatal onError", () => {
    // core_died is handled separately from generic error.
    expect(playerSource).toContain('case "core_died":');
    // It must emit the dedicated onCoreDied signal (recoverable).
    expect(playerSource).toContain("this.onCoreDied(reason)");
    // Fallback still marks the error recoverable so it never goes terminal.
    expect(playerSource).toContain("this.onError(reason, true /* recoverable */)");
  });

  it("resets session state so a relaunch re-issues start_game", () => {
    // The reload depends on clearing gameStarted so doConnect()'s
    // `if (!gameStarted)` branch re-issues start_game for a fresh session.
    expect(bootstrapSource).toContain("gameStarted = false;");
    // The relaunch routine must explicitly reset the whole session state.
    expect(bootstrapSource).toContain("sdpAnswer = null;");
    expect(bootstrapSource).toContain("startGameToken = null;");
    expect(bootstrapSource).toContain("coreCrashAttempts++;");
  });

  it("bounds relaunches independently of the reconnect counter", () => {
    // Deterministic core faults must not loop forever across reconnects.
    expect(bootstrapSource).toContain("MAX_CORE_CRASH_RELAUNCHES = 3");
    expect(bootstrapSource).toContain("coreCrashAttempts <= MAX_RELAUNCH");
    // On exhaustion, surface a terminal message instead of relaunching again.
    expect(bootstrapSource).toContain('player._showStatus("Game keeps crashing"');
  });

  it("suppresses the generic ERROR→doReconnect while a relaunch is in flight", () => {
    // A crash sets State.ERROR; the relaunch path issues its own doConnect
    // and manages its own counter — the network reconnect must not double-fire.
    expect(bootstrapSource).toContain("!isRelaunching &&");
    // Relaunch issues its own doConnect via a short delay.
    expect(bootstrapSource).toContain("setTimeout(() => { doConnect(); }, RECONNECT_DELAY_MS)");
  });
});