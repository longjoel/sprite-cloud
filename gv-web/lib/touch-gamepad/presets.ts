// ── Touch Gamepad — console presets & default layout computation ──────────

import type { ConsolePreset, LayoutData, NormalisedRect, PresetName } from "./types";

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export const PRESETS: Record<string, ConsolePreset> = {
  nes: {
    face: [{ label: "B" }, { label: "A" }],
    system: [{ label: "SELECT" }, { label: "START" }],
  },
  gamegear: {
    face: [{ label: "1" }, { label: "2" }],
    system: [{ label: "START" }],
  },
  genesis: {
    face: [{ label: "A" }, { label: "B" }, { label: "C" }],
    system: [{ label: "START" }],
  },
  arcade: {
    face: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }],
    system: [{ label: "COIN" }, { label: "START" }],
  },
  atari: {
    face: [{ label: "FIRE" }],
    system: [{ label: "SELECT" }, { label: "START" }],
  },
  snes: {
    face: [{ label: "B" }, { label: "A" }, { label: "Y" }, { label: "X" }],
    system: [{ label: "L" }, { label: "SELECT" }, { label: "START" }, { label: "R" }],
  },
};

/**
 * Compute default zone positions for a preset + orientation.
 * All coords are normalised 0..1 of the container.
 */
export function computeDefaults(
  preset: PresetName,
  orientation: string
): LayoutData {
  const cfg = PRESETS[preset] || PRESETS.nes;
  const nFace = cfg.face.length;
  const nSys = cfg.system.length;
  const isHoriz = orientation === "horizontal" || orientation === "landscape";

  let dpad: NormalisedRect = { x: 0, y: 0, w: 0, h: 0 };
  const face: import("./types").ButtonZone[] = [];
  const system: import("./types").ButtonZone[] = [];

  if (isHoriz) {
    // Horizontal: dpad left, face right, system bottom-center
    dpad = { x: 0.03, y: 0.48, w: 0.22, h: 0.46 };

    // Face buttons: grid anchored bottom-right
    let cols: number, rows: number, bw: number, bh: number, gap: number;
    if (nFace === 3) {
      // Genesis-style: 3 buttons in a single row
      cols = 3; rows = 1;
      bw = 0.08; bh = 0.13; gap = 0.02;
    } else {
      cols = nFace <= 2 ? 2 : Math.min(nFace, 3);
      rows = Math.ceil(nFace / cols);
      bw = 0.10; bh = 0.12; gap = 0.015;
    }

    const gridW = cols * bw + (cols - 1) * gap;
    const gridH = rows * bh + (rows - 1) * gap;
    const startX = 0.97 - gridW;
    const startY = 0.94 - gridH;

    for (let fi = 0; fi < nFace; fi++) {
      const col = fi % cols;
      const row = Math.floor(fi / cols);
      face.push({
        x: clamp(startX + col * (bw + gap), 0, 1),
        y: clamp(startY + row * (bh + gap), 0, 1),
        w: bw,
        h: bh,
        label: cfg.face[fi].label,
      });
    }

    // System buttons: horizontal row centered below dpad
    const sw = 0.09, sh = 0.05, sGap = 0.02;
    const sysW = nSys * sw + (nSys - 1) * sGap;
    const sysX = 0.50 - sysW / 2;
    const sysY = 0.92;
    for (let si = 0; si < nSys; si++) {
      system.push({
        x: sysX + si * (sw + sGap),
        y: sysY,
        w: sw,
        h: sh,
        label: cfg.system[si].label,
      });
    }
  } else {
    // Vertical: controls below video (canvas = dedicated control area)
    dpad = { x: 0.03, y: 0.08, w: 0.24, h: 0.52 };

    // Face buttons: compact action island anchored on the right.
    const vcols = Math.min(2, nFace);
    const vrows = Math.ceil(nFace / vcols);
    const vbw = 0.12, vbh = 0.16, vgap = 0.03;
    const faceW = vcols * vbw + (vcols - 1) * vgap;
    const faceH = vrows * vbh + (vrows - 1) * vgap;
    const faceX = 0.97 - faceW;
    const faceY = (0.72 - faceH) / 2;

    for (let vfi = 0; vfi < nFace; vfi++) {
      const col = vfi % vcols;
      const row = Math.floor(vfi / vcols);
      face.push({
        x: faceX + col * (vbw + vgap),
        y: faceY + row * (vbh + vgap),
        w: vbw,
        h: vbh,
        label: cfg.face[vfi].label,
      });
    }

    // Compact Select/Start island centered below the primary controls.
    const vsw = 0.12, vsh = 0.12, vsGap = 0.02;
    const sysW2 = nSys * vsw + (nSys - 1) * vsGap;
    const sysX2 = 0.50 - sysW2 / 2;
    const sysY2 = 0.80;
    for (let vsi = 0; vsi < nSys; vsi++) {
      system.push({
        x: sysX2 + vsi * (vsw + vsGap),
        y: sysY2,
        w: vsw,
        h: vsh,
        label: cfg.system[vsi].label,
      });
    }
  }

  return { dpad, face, system };
}
