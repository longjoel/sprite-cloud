// ── Pipeline types and helpers ─────────────────────────────────────────

export type StepState = "pending" | "active" | "done" | "failed";

export interface PipelineStep {
  id: string;
  label: string;
}

export const PIPELINE_STEPS: PipelineStep[] = [
  { id: "rtc", label: "RTC" },
  { id: "core", label: "Core" },
  { id: "stream", label: "Stream" },
  { id: "playing", label: "Playing" },
];

export function defaultPipeline(): Record<string, StepState> {
  const out: Record<string, StepState> = {};
  for (const s of PIPELINE_STEPS) {
    out[s.id] = s.id === "rtc" ? "active" : "pending";
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

// Legacy step IDs are mapped into the 4-phase pipeline so callers that
// still advance individual sub-steps (ice, server, core, encode, sdp,
// media, connected) update the right bucket.
export function mapLegacyStep(legacyId: string): string {
  switch (legacyId) {
    case "ice":
    case "server":
      return "rtc";
    case "core":
    case "encode":
      return "core";
    case "sdp":
    case "media":
      return "stream";
    case "connected":
      return "playing";
    default:
      return legacyId;
  }
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
