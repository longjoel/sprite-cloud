"use client";

import { Fullscreen, MeetingRoom } from "@mui/icons-material";
import { Button, Paper, Stack } from "@mui/material";

interface PlayerActionBarProps {
  onFullscreen: () => void;
  onOpenRoom: () => void;
  showRoomAction: boolean;
}

export default function PlayerActionBar({
  onFullscreen,
  onOpenRoom,
  showRoomAction,
}: PlayerActionBarProps) {
  return (
    <Paper variant="outlined" sx={{ mt: 1.5, p: 1 }}>
      <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
        {showRoomAction && (
          <Button startIcon={<MeetingRoom />} onClick={onOpenRoom}>
            Room
          </Button>
        )}
        <Button variant="contained" startIcon={<Fullscreen />} onClick={onFullscreen}>
          Fullscreen
        </Button>
      </Stack>
    </Paper>
  );
}
