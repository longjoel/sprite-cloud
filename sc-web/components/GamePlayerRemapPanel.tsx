"use client";

import { useEffect } from "react";
import { ArrowBack, Close } from "@mui/icons-material";
import { Box, Button, Paper, Stack, Typography } from "@mui/material";

const BUTTON_LABELS: Record<number, string> = {
  0: "B", 1: "Y", 2: "Select", 3: "Start", 4: "Up", 5: "Down",
  6: "Left", 7: "Right", 8: "A", 9: "X", 10: "L", 11: "R",
  12: "L2", 13: "R2", 14: "L3", 15: "R3",
};


export default function RemapPanel({
  playerRef,
  waiting,
  setWaiting,
  onClose,
  onBack,
}: {
  playerRef: React.RefObject<any>;
  waiting: string | null;
  setWaiting: (v: string | null) => void;
  onClose: () => void;
  onBack: () => void;
}) {
  const mapping = playerRef.current?.getKeyMapping?.() || {};

  // Build reverse map: bit → [keys]
  const bitKeys: Record<number, string[]> = {};
  for (const [key, bit] of Object.entries(mapping)) {
    const b = bit as number;
    if (!bitKeys[b]) bitKeys[b] = [];
    bitKeys[b].push(key);
  }

  // Listen for next keypress when waiting
  useEffect(() => {
    if (!waiting) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const bit = parseInt(waiting);
      if (playerRef.current?.setKeyMapping) {
        playerRef.current.setKeyMapping(e.key, bit);
      }
      setWaiting(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [waiting, playerRef, setWaiting]);

  return (
    <Paper
      elevation={8}
      sx={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 27,
        maxWidth: 380,
        width: "90vw",
        p: 3,
      }}
    >
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
          <Button size="small" variant="text" onClick={onBack}><ArrowBack aria-hidden="true" /> ← Options</Button>
          <Typography variant="subtitle2" color="text.secondary">Key Mapping</Typography>
          <Stack direction="row" spacing={0.5}>
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                playerRef.current?.resetKeymap?.();
                onClose();
              }}
            >
              Reset
            </Button>
            <Button size="small" variant="text" onClick={onClose}><Close aria-hidden="true" /> ✕ Close</Button>
          </Stack>
        </Stack>
        {waiting && (
          <Typography color="primary.main" sx={{ textAlign: "center" }}>
            Press a key for {BUTTON_LABELS[parseInt(waiting)] || `bit ${waiting}`}…
          </Typography>
        )}
        <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
          {Object.entries(BUTTON_LABELS).map(([bitStr, label]) => {
            const bit = parseInt(bitStr);
            const keys = bitKeys[bit] || [];
            return (
              <Button
                key={bit}
                variant="outlined"
                onClick={() => setWaiting(bitStr)}
                sx={{
                  justifyContent: "space-between",
                  outline: waiting === bitStr ? "2px solid" : undefined,
                  outlineColor: "primary.main",
                }}
              >
                <Typography component="span" variant="body2">{label}</Typography>
                <Typography component="span" variant="caption" color="primary.main">
                  {keys.length > 0 ? keys.slice(0, 3).join(", ") : "—"}
                </Typography>
              </Button>
            );
          })}
        </Box>
      </Stack>
    </Paper>
  );
}
