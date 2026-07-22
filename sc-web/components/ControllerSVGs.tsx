// SVG controller components with visual pressed-state feedback.
// Each controller accepts a `pressed` bitmask and renders the platform-specific layout.

import React from "react";

type ControllerProps = {
  pressed: number; // 16-bit libretro joypad mask
  size?: number;
  opacity?: number;
};

// ── Libretro bit constants ─────────────────────────────────────────
const B  = 0, Y  = 1, SEL = 2, START = 3;
const UP = 4, DN = 5, LT = 6, RT = 7;
const A  = 8, X  = 9, L  = 10, R = 11;
const C  = A; // Genesis: C button maps to RetroPad A position

const on  = (mask: number, bit: number) => !!(mask & (1 << bit));
const clr = (active: boolean, base: string, glow: string) => active ? glow : base;
const sz  = (active: boolean, scale: number) => active ? scale * 1.05 : scale;

// ── SNES Controller ────────────────────────────────────────────────
export const SNESController: React.FC<ControllerProps> = ({ pressed, size = 160 }) => {
  const s = (n: number) => n * (size / 160);
  return (
    <svg width={size} height={size * 0.68} viewBox="0 0 160 108" role="img" aria-label="SNES controller">
      {/* Body */}
      <rect x={2} y={2} width={156} height={104} rx={12} fill="#c0c0d0" stroke="#707080" strokeWidth={1.5} />
      {/* D-pad area */}
      <rect x={14} y={20} width={54} height={54} rx={4} fill="#808090" opacity={0.3} />
      {/* D-pad up */}
      <path d="M41 24 L37 32 L45 32 Z" fill={clr(on(pressed, UP), "#303040", "#ffe040")} stroke="#202030" />
      {/* D-pad down */}
      <path d="M41 62 L37 54 L45 54 Z" fill={clr(on(pressed, DN), "#303040", "#ffe040")} />
      {/* D-pad left */}
      <path d="M24 43 L32 39 L32 47 Z" fill={clr(on(pressed, LT), "#303040", "#ffe040")} />
      {/* D-pad right */}
      <path d="M58 43 L50 39 L50 47 Z" fill={clr(on(pressed, RT), "#303040", "#ffe040")} />
      {/* Center dpad circle */}
      <circle cx={41} cy={43} r={4} fill="#505060" />
      {/* Face buttons */}
      <circle cx={104} cy={32} r={sz(on(pressed, X), 8)} fill={clr(on(pressed, X), "#3040a0", "#6080ff")} />
      <text x={104} y={33} textAnchor="middle" fontSize={7} fill="#fff" fontWeight="bold">X</text>
      <circle cx={120} cy={43} r={sz(on(pressed, A), 8)} fill={clr(on(pressed, A), "#b02020", "#ff3030")} />
      <text x={120} y={44} textAnchor="middle" fontSize={7} fill="#fff" fontWeight="bold">A</text>
      <circle cx={104} cy={54} r={sz(on(pressed, B), 8)} fill={clr(on(pressed, B), "#20a030", "#40ff50")} />
      <text x={104} y={55} textAnchor="middle" fontSize={7} fill="#fff" fontWeight="bold">B</text>
      <circle cx={88} cy={43} r={sz(on(pressed, Y), 8)} fill={clr(on(pressed, Y), "#b0a020", "#ffff40")} />
      <text x={88} y={44} textAnchor="middle" fontSize={7} fill="#000" fontWeight="bold">Y</text>
      {/* Shoulders */}
      <rect x={18} y={8} width={40} height={10} rx={4} fill={clr(on(pressed, L), "#505060", "#80c0ff")} />
      <text x={38} y={16} textAnchor="middle" fontSize={6} fill="#fff">L</text>
      <rect x={102} y={8} width={40} height={10} rx={4} fill={clr(on(pressed, R), "#505060", "#80c0ff")} />
      <text x={122} y={16} textAnchor="middle" fontSize={6} fill="#fff">R</text>
      {/* Select / Start */}
      <rect x={56} y={64} width={20} height={8} rx={3} fill={clr(on(pressed, SEL), "#404050", "#a0a0ff")} />
      <rect x={84} y={64} width={20} height={8} rx={3} fill={clr(on(pressed, START), "#404050", "#a0a0ff")} />
    </svg>
  );
};

// ── Genesis / Mega Drive 3-button ───────────────────────────────────
export const GenesisController: React.FC<ControllerProps> = ({ pressed, size = 160 }) => {
  const s = (n: number) => n * (size / 160);
  return (
    <svg width={size} height={size * 0.68} viewBox="0 0 160 108" role="img" aria-label="Genesis controller">
      <rect x={2} y={2} width={156} height={104} rx={10} fill="#1a1a1a" stroke="#404040" strokeWidth={1.5} />
      {/* D-pad circle */}
      <circle cx={42} cy={48} r={28} fill="#2a2a2a" stroke="#333" />
      <path d="M42 24 L38 32 L46 32 Z" fill={clr(on(pressed, UP), "#1a1a1a", "#666")} />
      <path d="M42 72 L38 64 L46 64 Z" fill={clr(on(pressed, DN), "#1a1a1a", "#666")} />
      <path d="M18 48 L26 44 L26 52 Z" fill={clr(on(pressed, LT), "#1a1a1a", "#666")} />
      <path d="M66 48 L58 44 L58 52 Z" fill={clr(on(pressed, RT), "#1a1a1a", "#666")} />
      {/* A/B/C — Genesis: A=Y, B=B, C=A positions */}
      <circle cx={116} cy={32} r={sz(on(pressed, A), 10)} fill={clr(on(pressed, A), "#3a3a3a", "#ff4444")} />
      <circle cx={96} cy={50} r={sz(on(pressed, B), 10)} fill={clr(on(pressed, B), "#3a3a3a", "#44aaff")} />
      <circle cx={136} cy={50} r={sz(on(pressed, C), 10)} fill={clr(on(pressed, C), "#3a3a3a", "#888")} />
      {/* Start */}
      <rect x={120} y={80} width={28} height={10} rx={4} fill={clr(on(pressed, START), "#2a2a2a", "#fff")} />
      <text x={134} y={88} textAnchor="middle" fontSize={6} fill={on(pressed, START) ? "#000" : "#555"}>START</text>
    </svg>
  );
};

// ── PSX Controller (DualShock-inspired) ────────────────────────────
export const PSXController: React.FC<ControllerProps> = ({ pressed, size = 180 }) => {
  const s = (n: number) => n * (size / 180);
  return (
    <svg width={size} height={size * 0.78} viewBox="0 0 180 140" role="img" aria-label="PlayStation controller">
      {/* Body */}
      <ellipse cx={90} cy={72} rx={70} ry={55} fill="#404040" stroke="#606060" strokeWidth={1} />
      {/* Grips */}
      <path d="M25 90 Q15 120 30 135 L45 135 Q35 115 40 90 Z" fill="#363636" />
      <path d="M155 90 Q165 120 150 135 L135 135 Q145 115 140 90 Z" fill="#363636" />
      {/* D-pad */}
      <rect x={28} y={32} width={36} height={36} rx={2} fill="#505050" opacity={0.5} />
      <path d="M46 34 L42 42 L50 42 Z" fill={clr(on(pressed, UP), "#3a3a3a", "#aaa")} />
      <path d="M46 64 L42 56 L50 56 Z" fill={clr(on(pressed, DN), "#3a3a3a", "#aaa")} />
      <path d="M30 50 L38 46 L38 54 Z" fill={clr(on(pressed, LT), "#3a3a3a", "#aaa")} />
      <path d="M62 50 L54 46 L54 54 Z" fill={clr(on(pressed, RT), "#3a3a3a", "#aaa")} />
      {/* Face: △ ○ ✕ □ */}
      <polygon points="130,32 138,44 122,44" fill={clr(on(pressed, X), "#204020", "#40ff40")} stroke="#306030" />
      <circle cx={130} cy={55} r={sz(on(pressed, A), 6)} fill={clr(on(pressed, A), "#601010", "#ff2020")} />
      <path d="M122 62 L126 66 L130 62 L126 58 Z" fill={clr(on(pressed, B), "#202060", "#4040ff")} />
      <rect x={136} y={50} width={12} height={12} rx={2} fill={clr(on(pressed, Y), "#603060", "#ff60ff")} />
      {/* L1/R1 */}
      <rect x={14} y={14} width={44} height={12} rx={5} fill={clr(on(pressed, L), "#505050", "#80c0ff")} />
      <text x={36} y={23} textAnchor="middle" fontSize={7} fill="#aaa">L1</text>
      <rect x={122} y={14} width={44} height={12} rx={5} fill={clr(on(pressed, R), "#505050", "#80c0ff")} />
      <text x={144} y={23} textAnchor="middle" fontSize={7} fill="#aaa">R1</text>
      {/* L2/R2 — below shoulders */}
      <rect x={18} y={2} width={40} height={10} rx={4} fill={clr(on(pressed, L + 2) || false, "#404040", "#ff8080")} />
      <text x={38} y={10} textAnchor="middle" fontSize={6} fill="#999">L2</text>
      <rect x={122} y={2} width={40} height={10} rx={4} fill={clr(on(pressed, R + 2) || false, "#404040", "#ff8080")} />
      <text x={142} y={10} textAnchor="middle" fontSize={6} fill="#999">R2</text>
      {/* Select / Start */}
      <ellipse cx={74} cy={96} rx={10} ry={6} fill={clr(on(pressed, SEL), "#3a3a3a", "#8080ff")} />
      <ellipse cx={106} cy={96} rx={10} ry={6} fill={clr(on(pressed, START), "#3a3a3a", "#8080ff")} />
    </svg>
  );
};

// ── Game Boy ────────────────────────────────────────────────────────
export const GameBoyController: React.FC<ControllerProps> = ({ pressed, size = 140 }) => {
  const s = (n: number) => n * (size / 140);
  return (
    <svg width={size} height={size * 0.9} viewBox="0 0 140 126" role="img" aria-label="Game Boy">
      <rect x={2} y={2} width={136} height={122} rx={8} fill="#8b7d9b" stroke="#6a5f78" strokeWidth={1.5} />
      {/* Screen */}
      <rect x={10} y={8} width={80} height={56} rx={4} fill="#8bac0f" stroke="#306230" />
      {/* D-pad */}
      <circle cx={30} cy={90} r={16} fill="#2a1a3a" />
      <path d="M30 76 L27 82 L33 82 Z" fill={clr(on(pressed, UP), "#1a0a2a", "#606")} />
      <path d="M30 104 L27 98 L33 98 Z" fill={clr(on(pressed, DN), "#1a0a2a", "#606")} />
      <path d="M14 90 L20 87 L20 93 Z" fill={clr(on(pressed, LT), "#1a0a2a", "#606")} />
      <path d="M46 90 L40 87 L40 93 Z" fill={clr(on(pressed, RT), "#1a0a2a", "#606")} />
      {/* A/B — Game Boy: A=right, B=bottom (RetroPad A/B positions) */}
      <circle cx={118} cy={82} r={sz(on(pressed, A), 8)} fill={clr(on(pressed, A), "#601040", "#e040a0")} />
      <text x={118} y={83} textAnchor="middle" fontSize={6} fill="#fff">A</text>
      <circle cx={98} cy={94} r={sz(on(pressed, B), 8)} fill={clr(on(pressed, B), "#601040", "#e040a0")} />
      <text x={98} y={95} textAnchor="middle" fontSize={6} fill="#fff">B</text>
      {/* Select / Start */}
      <rect x={72} y={104} width={24} height={6} rx={3} fill={clr(on(pressed, SEL), "#4a3a5a", "#888")} transform="rotate(-25 84 107)" />
      <rect x={100} y={104} width={24} height={6} rx={3} fill={clr(on(pressed, START), "#4a3a5a", "#888")} transform="rotate(-25 112 107)" />
    </svg>
  );
};

// ── Platform selector ───────────────────────────────────────────────
const controllers: Record<string, React.FC<ControllerProps>> = {
  snes: SNESController,
  genesis: GenesisController,
  megadrive: GenesisController,
  psx: PSXController,
  playstation: PSXController,
  gameboy: GameBoyController,
  gb: GameBoyController,
  gbc: GameBoyController,
};

export function controllerForPlatform(platform: string): React.FC<ControllerProps> | null {
  const key = (platform || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return controllers[key] || null;
}
