"use client";

import {
  FluentProvider as FluentProviderBase,
  webDarkTheme,
  type Theme,
} from "@fluentui/react-components";

// ── Sprite Cloud custom theme — extends Fluent's webDarkTheme ───────
// Metro-inspired: sharp corners, tight spacing, one accent color.

const spriteCloudTheme: Theme = {
  ...webDarkTheme,

  // Sharp corners (Metro = no rounded corners)
  borderRadiusNone: "0",
  borderRadiusSmall: "2px",
  borderRadiusMedium: "2px",
  borderRadiusLarge: "2px",
  borderRadiusXLarge: "2px",

  // Tighter spacing
  spacingHorizontalNone: "0",
  spacingHorizontalXXS: "2px",
  spacingHorizontalXS: "4px",
  spacingHorizontalSNudge: "6px",
  spacingHorizontalS: "8px",
  spacingHorizontalMNudge: "10px",
  spacingHorizontalM: "12px",
  spacingHorizontalL: "16px",
  spacingHorizontalXL: "20px",
  spacingHorizontalXXL: "24px",
  spacingHorizontalXXXL: "32px",

  // Accent color — sky blue
  colorBrandForeground1: "#38bdf8",
  colorBrandForeground2: "#7dd3fc",
  colorBrandBackground: "#0c4a6e",
  colorBrandBackgroundHover: "#075985",
  colorBrandBackgroundPressed: "#082f49",

  // Neutral palette stays dark
  colorNeutralForeground1: "#e5e7eb",
  colorNeutralForeground2: "#d1d5db",
  colorNeutralForeground3: "#9ca3b8",
  colorNeutralForegroundDisabled: "#4b5563",
  colorNeutralBackground1: "#0a0e1a",
  colorNeutralBackground2: "#111827",
  colorNeutralBackground3: "#1a2236",
  colorNeutralBackground4: "#1f2937",
};

export default function SpriteCloudProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <FluentProviderBase theme={spriteCloudTheme}>
      {children}
    </FluentProviderBase>
  );
}
