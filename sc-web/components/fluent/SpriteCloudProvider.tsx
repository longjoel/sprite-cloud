"use client";

import {
  FluentProvider as FluentProviderBase,
  webDarkTheme,
  type Theme,
} from "@fluentui/react-components";
import { tokens } from "@/lib/design-tokens";

// ── Sprite Cloud custom theme — consumes canonical design tokens ────

const spriteCloudTheme: Theme = {
  ...webDarkTheme,

  // Sharp corners (Metro)
  borderRadiusNone: tokens.radius.none,
  borderRadiusSmall: tokens.radius.sm,
  borderRadiusMedium: tokens.radius.sm,
  borderRadiusLarge: tokens.radius.sm,
  borderRadiusXLarge: tokens.radius.sm,

  // Tighter spacing
  spacingHorizontalNone: tokens.space[0],
  spacingHorizontalXXS: tokens.space[1],
  spacingHorizontalXS: tokens.space[2],
  spacingHorizontalSNudge: tokens.space[3],
  spacingHorizontalS: tokens.space[4],
  spacingHorizontalMNudge: "10px",
  spacingHorizontalM: tokens.space[5],
  spacingHorizontalL: tokens.space[6],
  spacingHorizontalXL: "20px",
  spacingHorizontalXXL: tokens.space[7],
  spacingHorizontalXXXL: tokens.space[8],

  // Brand — sky blue
  colorBrandForeground1: tokens.fluent.brandForeground1,
  colorBrandForeground2: tokens.fluent.brandForeground2,
  colorBrandBackground: tokens.fluent.brandBackground,
  colorBrandBackgroundHover: tokens.fluent.brandBackgroundHover,
  colorBrandBackgroundPressed: tokens.fluent.brandBackgroundPressed,

  // Neutral palette
  colorNeutralForeground1: tokens.fluent.neutralForeground1,
  colorNeutralForeground2: tokens.fluent.neutralForeground2,
  colorNeutralForeground3: tokens.fluent.neutralForeground3,
  colorNeutralForegroundDisabled: tokens.fluent.neutralForegroundDisabled,
  colorNeutralBackground1: tokens.fluent.neutralBackground1,
  colorNeutralBackground2: tokens.fluent.neutralBackground2,
  colorNeutralBackground3: tokens.fluent.neutralBackground3,
  colorNeutralBackground4: tokens.fluent.neutralBackground4,
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
