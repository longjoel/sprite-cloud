"use client";

import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
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
    <Stack spacing={3}>
      {error && <Alert severity="error">{error}</Alert>}

      <Paper component="section" variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <Stack spacing={2}>
          <Typography component="h2" variant="h5">Runtime</Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
            <Badge>{metadata?.version ? `sc-server ${metadata.version}` : "Version unavailable"}</Badge>
            <Badge>{metadata?.ice?.turn_configured ? "TURN ready" : "TURN not configured"}</Badge>
            {metadata?.ice?.transport_policy && <Badge>{`ICE ${metadata.ice.transport_policy}`}</Badge>}
            {metadata?.runtime?.pc_pool_size !== undefined && <Badge>{`Pool ${metadata.runtime.pc_pool_size}`}</Badge>}
          </Box>
          <Typography variant="body2" color="text.secondary">
            Updates verify and install both sc-server and sc-core, then restart this server. Updates are blocked while a game is active.
          </Typography>
          <Box>
            <Button
              type="button"
              variant="contained"
              disabled={updateState === "queued" || updateState === "running"}
              onClick={requestUpdate}
            >
              {updateState === "queued" ? "Update queued" : updateState === "running" ? "Updating…" : "Update server"}
            </Button>
          </Box>
          {updateMessage && (
            <Alert severity={updateState === "failed" ? "error" : "info"}>{updateMessage}</Alert>
          )}
        </Stack>
      </Paper>

      <Paper component="section" variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <Stack spacing={2}>
          <Typography component="h2" variant="h5">Core overrides</Typography>
          <Typography variant="body2" color="text.secondary">
            Game discovery, library metadata, and ROM paths stay on sc-server.
          </Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 2 }}>
            {PLATFORM_CORES.map(({ platform, defaultCore }) => {
              const labelId = `core-label-${platform.replace(/\s+/g, "-").toLowerCase()}`;
              return (
                <FormControl key={platform} size="small" fullWidth>
                  <InputLabel id={labelId}>{platform}</InputLabel>
                  <Select
                    labelId={labelId}
                    label={platform}
                    value={coreOverrides[platform] || defaultCore}
                    onChange={(event) => setCore(platform, event.target.value)}
                  >
                    {CORE_OPTIONS.map((option) => (
                      <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              );
            })}
          </Box>
        </Stack>
      </Paper>

      <Paper component="section" variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <Stack spacing={2}>
          <Typography component="h2" variant="h5">Arcade & Free Play</Typography>
          <Typography variant="body2" color="text.secondary">
            Enable always-on to keep the game running as a living cabinet
            on the wall. Free play auto-inserts a credit at startup.
          </Typography>
          {games.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No games synced yet from this server.</Typography>
          ) : (
            <Stack spacing={1.5}>
              {games.map((g) => {
                const flags = gameFlags[g.game_id] ?? { always_on: false, free_play: false };
                const aLoading = flagLoading.has(`${g.game_id}:always_on`);
                const fLoading = flagLoading.has(`${g.game_id}:free_play`);
                return (
                  <Paper key={g.game_id} variant="outlined" sx={{ p: 1.5 }}>
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" } }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography noWrap sx={{ fontWeight: 700 }}>{g.name}</Typography>
                        <Typography variant="body2" color="text.secondary">{g.platform}</Typography>
                      </Box>
                      <FormControlLabel
                        control={<Switch size="small" checked={flags.always_on} disabled={aLoading} onChange={() => toggleFlag(g.game_id, "always_on")} />}
                        label="Always on"
                      />
                      <FormControlLabel
                        control={<Switch size="small" checked={flags.free_play} disabled={fLoading} onChange={() => toggleFlag(g.game_id, "free_play")} />}
                        label="Free play"
                      />
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
