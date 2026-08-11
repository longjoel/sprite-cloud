"use client";

import { forwardRef, type ReactNode } from "react";
import { Paper } from "@mui/material";

interface GameStageProps {
  children: ReactNode;
}

const GameStage = forwardRef<HTMLDivElement, GameStageProps>(function GameStage(
  { children },
  ref,
) {
  return (
    <Paper
      ref={ref}
      data-game-stage
      elevation={8}
      sx={{
        position: "relative",
        width: "100%",
        aspectRatio: "4 / 3",
        maxHeight: { xs: "min(68dvh, 720px)", md: "min(72dvh, 820px)" },
        overflow: "hidden",
        bgcolor: "common.black",
        border: 1,
        borderColor: "divider",
        borderRadius: { xs: 0, sm: 1 },
        "&:fullscreen": {
          width: "100vw",
          height: "100dvh",
          maxHeight: "none",
          aspectRatio: "auto",
          border: 0,
          borderRadius: 0,
        },
      }}
    >
      {children}
    </Paper>
  );
});

export default GameStage;
