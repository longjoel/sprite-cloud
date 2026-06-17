/**
 * Games Vault Design Tokens
 *
 * 1960s Neo-Futurism — warm wood tones, brass trim, neon accents.
 * "Games Humidor" — not a cold vault, a warm cabinet.
 *
 * Exports both CSS custom properties (for `globals.css`) and a typed
 * TypeScript object (for inline styles and component props).
 * Single source of truth.  Change a token here, changes everywhere.
 */

// ═══════════════════════════════════════════════════════════════════════
// Colors
// ═══════════════════════════════════════════════════════════════════════

const colors = {
  // Background depth hierarchy (dark → light)
  mahogany: "#1a1410", // Deepest page background
  teak:     "#2d2418", // Card panels, surfaces
  walnut:   "#3d3020", // Modals, elevated panels
  bamboo:   "#4a3a28", // Active states, hover

  // Trim & hardware
  brass:  "#b8964a", // Borders, dividers, metal elements
  copper: "#c4723a", // Warmer alternative trim (sparing use)

  // Text
  cream: "#e8dcc8", // Primary body text
  muted: "#b8a888", // Secondary, labels, dim text

  // Neon accents (used sparingly)
  cyan:    "#00e5ff", // Focus, links, active
  magenta: "#ff3d7f", // Alerts, emphasis, danger
  lime:    "#a0ff40", // Play, go, success

  // Semantic status
  success: "#4dff88", // Healthy, online, connected
  warning: "#ffb830", // Degraded, relay, stale
  error:   "#ff4d4d", // Offline, failed, dead
  info:    "#00e5ff", // Informational (same as cyan)

  // Status backgrounds (translucent overlays on wood tones)
  successBg: "rgba(77, 255, 136, 0.10)",
  warningBg: "rgba(255, 184, 48, 0.10)",
  errorBg:   "rgba(255, 77, 77, 0.08)",
  infoBg:    "rgba(0, 229, 255, 0.08)",
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
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Border radius
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
    base: "13px",
    md:   "14px",
    lg:   "16px",
    xl:   "18px",
    h3:   "20px",
    h2:   "1rem",    // relative to parent
    h1:   "1.5rem",
  },

  weight: {
    normal:  "400",
    medium:  "500",
    semibold: "600",
    bold:    "700",
  },

  leading: {
    tight:  "1.3",
    normal: "1.6",
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Borders
// ═══════════════════════════════════════════════════════════════════════

const border = {
  thin:  `1px solid ${colors.brass}`,
  thick: `2px solid ${colors.brass}`,
  focus: `1px solid ${colors.cyan}`,
  error: `1px solid ${colors.error}`,
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Shadows (hardware, not glass)
// ═══════════════════════════════════════════════════════════════════════

const shadow = {
  // Subtle inner shadow for button depth (physical press feel)
  inner:   "inset 0 1px 0 rgba(255,255,255,0.04)",
  // Raised panel — slight lift via border, not box-shadow
  raised:  "0 1px 0 rgba(0,0,0,0.3)",
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Animation
// ═══════════════════════════════════════════════════════════════════════

const motion = {
  fast:    "0.1s ease",
  normal:  "0.15s ease",
  slow:    "0.3s ease",
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Z-index scale
// ═══════════════════════════════════════════════════════════════════════

const z = {
  base:   "0",
  raised: "10",
  sticky: "100",
  modal:  "1000",
  toast:  "2000",
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════

/** All design tokens as a flat typed object. */
export const tokens = {
  color:  colors,
  space,
  radius,
  font,
  border,
  shadow,
  motion,
  z,
} as const;

export type Tokens = typeof tokens;

/**
 * CSS custom properties string (for `:root` in `globals.css`).
 * Generate once, paste into the CSS file.
 */
export function cssCustomProperties(): string {
  const lines: string[] = ["/* Games Vault Design Tokens — generated from lib/design-tokens.ts */"];

  for (const [name, value] of Object.entries(colors)) {
    lines.push(`  --color-${name}: ${value};`);
  }
  for (const [name, value] of Object.entries(space)) {
    lines.push(`  --space-${name}: ${value};`);
  }
  for (const [name, value] of Object.entries(radius)) {
    lines.push(`  --radius-${name}: ${value};`);
  }
  for (const [key, val] of Object.entries(font.size)) {
    lines.push(`  --font-size-${key}: ${val};`);
  }
  lines.push(`  --font-mono: ${font.mono};`);
  lines.push(`  --font-sans: ${font.sans};`);

  return lines.join("\n");
}

// Print CSS custom properties when run directly:
//   npx tsx lib/design-tokens.ts
if (require.main === module || process.env.GENERATE_CSS) {
  console.log(cssCustomProperties());
}
