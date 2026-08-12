"use client";

import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { Badge } from "@/components/ui";
import { csrfHeaders } from "./dashboard-utils";

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
  const [error, setError] = useState<string | null>(null);

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

    </Stack>
  );
}
