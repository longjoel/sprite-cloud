// ── Touch Gamepad — type definitions ──────────────────────────────────────

export interface FaceButtonDef {
  label: string;
}

export interface SystemButtonDef {
  label: string;
}

export interface ConsolePreset {
  face: FaceButtonDef[];
  system: SystemButtonDef[];
}

export interface NormalisedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ButtonZone extends NormalisedRect {
  label: string;
}

export interface LayoutData {
  dpad: NormalisedRect;
  face: ButtonZone[];
  system: ButtonZone[];
}

export type Orientation = "horizontal" | "vertical" | "auto";

export type PresetName = "nes" | "snes" | "genesis" | "gamegear" | "arcade" | "atari";

export interface TouchGamepadOptions {
  preset?: PresetName;
  layout?: Orientation;
}

export interface DragTarget {
  kind: "resize" | "move";
  zone: string;
  index?: number;
  tag?: string;
}

export interface DragStart {
  fingerId: number;
  nx: number;
  ny: number;
  tx: number;
  ty: number;
  tw: number;
  th: number;
  mode: "resize" | "move";
}

export interface TouchNormPoint {
  x: number;
  y: number;
}

export type InputCallback = (state: {
  dpad: [boolean, boolean, boolean, boolean];
  face: boolean[];
  system: boolean[];
}) => void;
