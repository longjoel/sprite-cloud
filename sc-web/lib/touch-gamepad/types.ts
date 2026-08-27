// ── Touch Gamepad — type definitions ──────────────────────────────────────

interface FaceButtonDef {
  label: string;
}

interface SystemButtonDef {
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
  stick?: NormalisedRect | null;
}

export type Orientation = "horizontal" | "vertical" | "auto";

export type PresetName = "nes" | "snes" | "genesis" | "gamegear" | "arcade" | "atari" | "psx" | "n64";

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

export type InputCallback = (state: {
  dpad: [boolean, boolean, boolean, boolean];
  face: boolean[];
  system: boolean[];
  stick?: { x: number; y: number };
}) => void;
