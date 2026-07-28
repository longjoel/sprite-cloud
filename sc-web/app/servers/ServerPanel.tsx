"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui";

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      setError("Unable to save core override.");
    }
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
  error: { margin: 0, border: "1px solid var(--color-danger)", color: "var(--color-danger)", padding: "var(--space-3)" },
};
