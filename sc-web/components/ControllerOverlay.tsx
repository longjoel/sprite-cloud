"use client";

import React, { useEffect, useRef, useState } from "react";
import { controllerForPlatform, GameBoyController } from "./ControllerSVGs";

// 16-bit mask covering the gamepad-owned joypad bits (0-11)
const GAMEPAD_MASK = (() => {
  let mask = 0;
  for (let i = 0; i < 12; i++) mask |= 1 << i;
  return mask;
})();

type PlayerInput = {
  seat: number;
  name: string;
  platform: string;
  mask: number; // 16-bit libretro joypad bitmask
};

type ControllerOverlayProps = {
  /** Players to display. If omitted, reads from window.scPlayer._inputState. */
  players?: PlayerInput[];
  /** Platform for local (self) controller. Falls back to "snes". */
  platform?: string;
  /** Hide/show toggle. */
  visible?: boolean;
};

/** Poll the local ScPlayer instance for the current input mask. */
function useLocalInputMask(): number {
  const [mask, setMask] = useState(0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const poll = () => {
      const player = (window as any).scPlayer;
      if (player && typeof player._inputState === "number") {
        setMask(player._inputState & GAMEPAD_MASK);
      }
      raf.current = requestAnimationFrame(poll);
    };
    raf.current = requestAnimationFrame(poll);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, []);

  return mask;
}

export const ControllerOverlay: React.FC<ControllerOverlayProps> = ({
  players,
  platform = "snes",
  visible = true,
}) => {
  const localMask = useLocalInputMask();

  if (!visible) return null;

  const allPlayers: PlayerInput[] = players || [
    { seat: 0, name: "P1", platform, mask: localMask },
  ];

  return (
    <div style={{
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      display: "flex",
      justifyContent: "center",
      gap: 24,
      padding: "8px 16px",
      background: "linear-gradient(transparent, rgba(0,0,0,0.7))",
      pointerEvents: "none",
      zIndex: 20,
    }}>
      {allPlayers.map((p) => {
        const Ctrl = controllerForPlatform(p.platform) || GameBoyController;
        return (
          <div key={p.seat} style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
          }}>
            <Ctrl pressed={p.mask} size={120} />
            <span style={{
              color: "#888",
              fontSize: 11,
              fontFamily: "monospace",
              textShadow: "0 0 4px rgba(0,0,0,0.8)",
            }}>
              {p.name}
            </span>
          </div>
        );
      })}
    </div>
  );
};
