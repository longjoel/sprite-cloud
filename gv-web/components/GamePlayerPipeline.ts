// ── Pipeline types and helpers ─────────────────────────────────────────

export type StepState = "pending" | "active" | "done" | "failed";

export interface PipelineStep {
  id: string;
  label: string;
}

export const PIPELINE_STEPS: PipelineStep[] = [
  { id: "ice", label: "ICE" },
  { id: "server", label: "Server" },
  { id: "game", label: "Game" },
  { id: "worker", label: "Worker" },
  { id: "handshake", label: "Handshake" },
  { id: "connected", label: "Playing" },
];

export function defaultPipeline(): Record<string, StepState> {
  const out: Record<string, StepState> = {};
  for (const s of PIPELINE_STEPS) {
    out[s.id] = s.id === "ice" ? "active" : "pending";
  }
  return out;
}

export function mergePipeline(
  base: Record<string, StepState>,
  overrides?: Record<string, StepState>,
): Record<string, StepState> {
  if (!overrides) return base;
  return { ...base, ...overrides };
}

// ── Route label → color ────────────────────────────────────────────────

export function routeVariant(routeLabel: string): "success" | "warning" | "error" | "info" | "muted" {
  const map: Record<string, "success" | "warning" | "error" | "info" | "muted"> = {
    local: "success",
    direct: "success",
    relay: "warning",
    host: "info",
    failed: "error",
    error: "error",
    unknown: "muted",
  };
  return map[routeLabel] || "muted";
}

// ── Pipeline dot helpers ──────────────────────────────────────────────

export function dotColor(state: StepState): string {
  switch (state) {
    case "done": return "var(--color-success)";
    case "failed": return "var(--color-error)";
    case "active": return "var(--color-brass)";
    default: return "var(--color-walnut)";
  }
}

export function dotChar(state: StepState): string {
  switch (state) {
    case "done": return "✓";
    case "failed": return "✖";
    case "active": return "●";
    default: return "○";
  }
}

export function labelColor(state: StepState): string {
  switch (state) {
    case "active": return "var(--color-cream)";
    case "failed": return "var(--color-error)";
    case "done": return "var(--color-success)";
    default: return "var(--color-muted)";
  }
}
