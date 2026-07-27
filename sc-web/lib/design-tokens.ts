/**
 * Sprite Cloud Design Tokens
 *
 * Single canonical source for all CSS variables and Fluent theme values.
 * No other file defines tokens — globals.css and SpriteCloudProvider
 * both consume this module.
 *
 * Surface: dark sky / Metro-inspired — sharp corners, tight spacing, one accent.
 */

// ═══════════════════════════════════════════════════════════════════════
// Backgrounds (sky depth)
// ═══════════════════════════════════════════════════════════════════════

const surface = {
  deep:     "#060b14", // page background
  mid:      "#111827", // cards, surfaces
  high:     "#1a2236", // buttons, raised panels
  overlay:  "rgba(2, 6, 23, 0.86)", // modal backdrop
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Text
// ═══════════════════════════════════════════════════════════════════════

const text = {
  primary:   "#e5e7eb", // headings, body
  secondary: "#9ca3b8", // muted, hints, dim text
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Accent (sky blue)
// ═══════════════════════════════════════════════════════════════════════

const accent = {
  main:  "#38bdf8",
  glow:  "rgba(56, 189, 248, 0.15)",
  muted: "rgba(56, 189, 248, 0.12)", // subtle border
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Pixel / decorative
// ═══════════════════════════════════════════════════════════════════════

const pixel = {
  green:  "#4ade80",
  pink:   "#f472b6",
  yellow: "#facc15",
  red:    "#f87171",
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Semantic
// ═══════════════════════════════════════════════════════════════════════

const status = {
  success:    "#4ade80",
  warning:    "#facc15",
  error:      "#f87171",
  info:       "#38bdf8",
  successBg:  "rgba(74, 222, 128, 0.10)",
  warningBg:  "rgba(250, 204, 21, 0.10)",
  errorBg:    "rgba(248, 113, 113, 0.08)",
  infoBg:     "rgba(56, 189, 248, 0.08)",
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Spacing (4px base scale)
// ═══════════════════════════════════════════════════════════════════════

const space = {
  0:  "0",
  1:  "2px",
  2:  "4px",
  3:  "6px",
  4:  "8px",
  5:  "12px",
  6:  "16px",
  7:  "24px",
  8:  "32px",
  9:  "48px",
  10: "64px",
  16: "64px",   // legacy alias — same as space-10
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Radii (Metro = sharp corners)
// ═══════════════════════════════════════════════════════════════════════

const radius = {
  none: "0",
  sm:   "2px",
  md:   "4px",
  pill: "9999px",
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Typography
// ═══════════════════════════════════════════════════════════════════════

const font = {
  mono:  "'Geist Mono', 'SF Mono', 'Fira Code', monospace",
  sans:  "'Geist', 'SF Pro', system-ui, sans-serif",

  size: {
    xs:   "10px",
    sm:   "12px",
    base: "14px",
    md:   "16px",
    lg:   "20px",
    xl:   "24px",
    h3:   "20px",
    h2:   "28px",
    h1:   "36px",
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Fluent theme overrides
// ═══════════════════════════════════════════════════════════════════════

const fluent = {
  brandForeground1:      accent.main,
  brandForeground2:      "#7dd3fc",
  brandBackground:       "#0c4a6e",
  brandBackgroundHover:  "#075985",
  brandBackgroundPressed:"#082f49",
  neutralForeground1:    text.primary,
  neutralForeground2:    "#d1d5db",
  neutralForeground3:    text.secondary,
  neutralForegroundDisabled: "#4b5563",
  neutralBackground1:    surface.deep,
  neutralBackground2:    surface.mid,
  neutralBackground3:    surface.high,
  neutralBackground4:    "#1f2937",
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════

export const tokens = { surface, text, accent, pixel, status, space, radius, font, fluent } as const;
export type Tokens = typeof tokens;

/** CSS custom properties for :root. */
export function cssCustomProperties(): string {
  const lines: string[] = [
    "/* Sprite Cloud Design Tokens — auto-generated */",
    ":root {",
    `  --color-bg-deep: ${surface.deep};`,
    `  --color-sky-deep: ${surface.deep};`,
    `  --color-sky-mid: ${surface.mid};`,
    `  --color-sky-high: ${surface.high};`,
    `  --color-cloud: ${text.primary};`,
    `  --color-cloud-dim: ${text.secondary};`,
    `  --color-accent: ${accent.main};`,
    `  --color-accent-glow: ${accent.glow};`,
    `  --color-pixel-green: ${pixel.green};`,
    `  --color-pixel-pink: ${pixel.pink};`,
    `  --color-pixel-yellow: ${pixel.yellow};`,
    `  --color-pixel-red: ${pixel.red};`,
    `  --color-success: ${status.success};`,
    `  --color-warning: ${status.warning};`,
    `  --color-error: ${status.error};`,
    `  --color-info: ${status.info};`,
    `  --color-successBg: ${status.successBg};`,
    `  --color-warningBg: ${status.warningBg};`,
    `  --color-errorBg: ${status.errorBg};`,
    `  --color-infoBg: ${status.infoBg};`,
    `  --color-surface-default: var(--color-sky-mid);`,
    `  --color-surface-raised: var(--color-sky-high);`,
    `  --color-text-primary: var(--color-cloud);`,
    `  --color-text-secondary: var(--color-cloud-dim);`,
    `  --color-text-dim: var(--color-text-secondary);`,  // legacy alias
    `  --color-border-default: ${accent.muted};`,
  ];

  for (const [k, v] of Object.entries(space)) lines.push(`  --space-${k}: ${v};`);
  for (const [k, v] of Object.entries(radius)) lines.push(`  --radius-${k}: ${v};`);
  for (const [k, v] of Object.entries(font.size)) lines.push(`  --font-size-${k}: ${v};`);
  lines.push(`  --font-mono: ${font.mono};`);
  lines.push(`  --font-sans: ${font.sans};`);
  lines.push("}");

  return lines.join("\n");
}
