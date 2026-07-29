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
