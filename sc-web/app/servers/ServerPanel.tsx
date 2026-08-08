"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui";
import { csrfHeaders } from "./dashboard-utils";
import { runServerUpgrade, type ServerUpdateState } from "@/lib/server-upgrade-client";

interface ComponentVersion {
  package_version: string;
  git_sha?: string;
  built_at_utc?: string;
}

interface ServerMetadata {
  version?: string;
  public_ip?: string;
  ice?: {
    turn_configured?: boolean;
    transport_policy?: string;
  };
  versions?: {
    server?: ComponentVersion;
    worker?: ComponentVersion;
    runner?: ComponentVersion;
  };
  runtime?: {
    pc_pool_size?: number;
    video_scale_height?: number;
    video_max_scale?: number;
  };
}

interface GameEntry {
  game_id: string;
  name: string;
  platform: string;
}

interface GameFlagEntry {
  always_on: boolean;
  free_play: boolean;
}

interface Props {
  serverId: string;
}

const PLATFORM_CORES = [
  { platform: "Game Boy", defaultCore: "gambatte_libretro.so" },
  { platform: "Game Boy Color", defaultCore: "gambatte_libretro.so" },
  { platform: "Game Boy Advance", defaultCore: "mgba_libretro.so" },
  { platform: "NES", defaultCore: "nestopia_libretro.so" },
  { platform: "SNES", defaultCore: "snes9x_libretro.so" },
  { platform: "Genesis", defaultCore: "genesis_plus_gx_libretro.so" },
  { platform: "Atari 2600", defaultCore: "stella2014_libretro.so" },
] as const;

const CORE_OPTIONS = [
  { value: "gambatte_libretro.so", label: "Gambatte" },
  { value: "sameboy_libretro.so", label: "SameBoy" },
  { value: "mgba_libretro.so", label: "mGBA" },
  { value: "nestopia_libretro.so", label: "Nestopia" },
  { value: "fceumm_libretro.so", label: "FCEUmm" },
  { value: "snes9x_libretro.so", label: "Snes9x" },
  { value: "genesis_plus_gx_libretro.so", label: "Genesis Plus GX" },
  { value: "stella2014_libretro.so", label: "Stella 2014" },
  { value: "stella_libretro.so", label: "Stella" },
] as const;

export default function ServerPanel({ serverId }: Props) {
  const [metadata, setMetadata] = useState<ServerMetadata | null>(null);
  const [coreOverrides, setCoreOverrides] = useState<Record<string, string>>({});
  const [updateState, setUpdateState] = useState<"idle" | ServerUpdateState>("idle");
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [games, setGames] = useState<GameEntry[]>([]);
  const [gameFlags, setGameFlags] = useState<Record<string, GameFlagEntry>>({});
  const [flagLoading, setFlagLoading] = useState<Set<string>>(new Set());

  useEffect(() => {
    Promise.all([
      fetch(`/api/servers/${serverId}/metadata`).then((response) => response.ok ? response.json() : null),
      fetch(`/api/servers/${serverId}/core-overrides`).then((response) => response.ok ? response.json() : null),
    ])
      .then(([metadataResponse, overridesResponse]) => {
        if (metadataResponse?.metadata) setMetadata(metadataResponse.metadata);
        if (overridesResponse?.overrides) setCoreOverrides(overridesResponse.overrides);
      })
      .catch(() => setError("Unable to load server details."));
  }, [serverId]);

  // Load server games and their flags
  useEffect(() => {
    fetch(`/api/servers/${serverId}/games`)
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        const list: GameEntry[] = data?.games ?? [];
        setGames(list);
        // Batch-load flags for all games
        return Promise.all(
          list.map((g: GameEntry) =>
            fetch(`/api/servers/${serverId}/game-flags/${encodeURIComponent(g.game_id)}`)
              .then((r) => r.ok ? r.json() : { alwaysOn: false, freePlay: false })
              .then((flags) => [g.game_id, flags] as const),
          ),
        );
      })
      .then((flagPairs) => {
        if (flagPairs) {
          const flagMap: Record<string, GameFlagEntry> = {};
          for (const [gid, flags] of flagPairs) {
            flagMap[gid] = flags;
          }
          setGameFlags(flagMap);
        }
      })
      .catch(() => {});
  }, [serverId]);

  async function setCore(platform: string, core: string) {
    const overrides = { ...coreOverrides, [platform]: core };
    setCoreOverrides(overrides);
    setError(null);
    try {
      const response = await fetch(`/api/servers/${serverId}/core-overrides`, {
        method: "PUT",
        headers: csrfHeaders(),
        body: JSON.stringify({ overrides }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      setError("Unable to save core override.");
    }
  }

  async function toggleFlag(gameId: string, flag: "always_on" | "free_play") {
    const current = gameFlags[gameId];
    if (!current) return;
    const newVal = !current[flag === "always_on" ? "always_on" : "free_play"];
    // Optimistic update
    setGameFlags((prev) => ({
      ...prev,
      [gameId]: { ...prev[gameId], [flag === "always_on" ? "always_on" : "free_play"]: newVal },
    }));
    setFlagLoading((prev) => new Set(prev).add(`${gameId}:${flag}`));
    try {
      const resp = await fetch(
        `/api/servers/${serverId}/game-flags/${encodeURIComponent(gameId)}`,
        {
          method: "PATCH",
          headers: csrfHeaders(),
          body: JSON.stringify({ [flag]: newVal }),
        },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch {
      // Revert on error
      setGameFlags((prev) => ({
        ...prev,
        [gameId]: { ...prev[gameId], [flag === "always_on" ? "always_on" : "free_play"]: !newVal },
      }));
    } finally {
      setFlagLoading((prev) => {
        const next = new Set(prev);
        next.delete(`${gameId}:${flag}`);
        return next;
      });
    }
  }

  async function requestUpdate() {
    await runServerUpgrade(serverId, csrfHeaders(), (state, message) => {
      setUpdateState(state);
      setUpdateMessage(message);
    });
  }

  return (
    <div style={S.wrapper}>
      {error && <p style={S.error}>{error}</p>}
      <section style={S.section}>
        <h2 style={S.heading}>Runtime</h2>
        <div style={S.badges}>
          <Badge>{metadata?.version ? `sc-server ${metadata.version}` : "Version unavailable"}</Badge>
          <Badge>{metadata?.ice?.turn_configured ? "TURN ready" : "TURN not configured"}</Badge>
          {metadata?.ice?.transport_policy && <Badge>{`ICE ${metadata.ice.transport_policy}`}</Badge>}
          {metadata?.runtime?.pc_pool_size !== undefined && <Badge>{`Pool ${metadata.runtime.pc_pool_size}`}</Badge>}
        </div>
        <p style={S.note}>Updates verify and install both sc-server and sc-core, then restart this server. Updates are blocked while a game is active.</p>
        <button
          type="button"
          style={S.updateButton}
          disabled={updateState === "queued" || updateState === "running"}
          onClick={requestUpdate}
        >
          {updateState === "queued" ? "Update queued" : updateState === "running" ? "Updating…" : "Update server"}
        </button>
        {updateMessage && <p style={updateState === "failed" ? S.error : S.note}>{updateMessage}</p>}
      </section>

      <section style={S.section}>
        <h2 style={S.heading}>Core overrides</h2>
        <p style={S.note}>Game discovery, library metadata, and ROM paths stay on sc-server.</p>
        <div style={S.coreGrid}>
          {PLATFORM_CORES.map(({ platform, defaultCore }) => (
            <label key={platform} style={S.field}>
              <span style={S.label}>{platform}</span>
              <select
                style={S.select}
                value={coreOverrides[platform] || defaultCore}
                onChange={(event) => setCore(platform, event.target.value)}
              >
                {CORE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>

      <section style={S.section}>
        <h2 style={S.heading}>Arcade & Free Play</h2>
        <p style={S.note}>
          Enable always-on to keep the game running as a living cabinet
          on the wall. Free play auto-inserts a credit at startup.
        </p>
        {games.length === 0 ? (
          <p style={S.empty}>No games synced yet from this server.</p>
        ) : (
          <div style={S.flagGrid}>
            {games.map((g) => {
              const flags = gameFlags[g.game_id] ?? { always_on: false, free_play: false };
              const aLoading = flagLoading.has(`${g.game_id}:always_on`);
              const fLoading = flagLoading.has(`${g.game_id}:free_play`);
              return (
                <div key={g.game_id} style={S.flagRow}>
                  <div style={S.flagGame}>
                    <span style={S.flagName}>{g.name}</span>
                    <span style={S.flagPlatform}>{g.platform}</span>
                  </div>
                  <label style={S.toggleLabel}>
                    <input
                      type="checkbox"
                      checked={flags.always_on}
                      disabled={aLoading}
                      onChange={() => toggleFlag(g.game_id, "always_on")}
                      style={S.toggleCheck}
                    />
                    Always on
                  </label>
                  <label style={S.toggleLabel}>
                    <input
                      type="checkbox"
                      checked={flags.free_play}
                      disabled={fLoading}
                      onChange={() => toggleFlag(g.game_id, "free_play")}
                      style={S.toggleCheck}
                    />
                    Free play
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrapper: { display: "grid", gap: "var(--space-5)" },
  section: { border: "1px solid var(--color-sky-high)", background: "var(--color-sky-mid)", padding: "var(--space-5)" },
  heading: { margin: "0 0 var(--space-3)", color: "var(--color-accent)", fontSize: "var(--font-size-lg)" },
  note: { margin: "0 0 var(--space-4)", color: "var(--color-cloud-dim)", fontSize: "var(--font-size-sm)" },
  badges: { display: "flex", flexWrap: "wrap", gap: "var(--space-2)" },
  coreGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--space-3)" },
  field: { display: "grid", gap: "var(--space-2)" },
  label: { color: "var(--color-cloud-dim)", fontSize: "var(--font-size-sm)" },
  select: { minHeight: 36, border: "1px solid var(--color-sky-high)", borderRadius: 2, background: "var(--color-sky-deep)", color: "var(--color-cloud)", padding: "0 var(--space-3)", fontFamily: "var(--font-mono)" },
  updateButton: { marginTop: "var(--space-2)", minHeight: 36, border: "1px solid var(--color-accent)", borderRadius: 2, background: "var(--color-accent)", color: "var(--color-sky-deep)", padding: "0 var(--space-3)", fontWeight: 700, cursor: "pointer" },
  error: { margin: 0, border: "1px solid var(--color-danger)", color: "var(--color-danger)", padding: "var(--space-3)" },
  flagGrid: { display: "grid", gap: "var(--space-3)" },
  flagRow: { display: "flex", alignItems: "center", gap: "var(--space-4)", padding: "var(--space-3)", border: "1px solid var(--color-sky-high)", borderRadius: 2 },
  flagGame: { flex: 1, display: "flex", flexDirection: "column", gap: 2 },
  flagName: { fontWeight: 700, fontSize: "var(--font-size-base)" },
  flagPlatform: { color: "var(--color-cloud-dim)", fontSize: "var(--font-size-sm)" },
  toggleLabel: { display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--color-cloud-dim)", fontSize: "var(--font-size-sm)", cursor: "pointer", whiteSpace: "nowrap" },
  toggleCheck: { cursor: "pointer", accentColor: "var(--color-accent)" },
  empty: { color: "var(--color-cloud-dim)", fontSize: "var(--font-size-sm)", margin: 0 },
};
