"use client";

import { MeetingRoom } from "@mui/icons-material";
import { Button, Paper, Stack } from "@mui/material";

interface PlayerActionBarProps {
  onOpenRoom: () => void;
  showRoomAction: boolean;
}

export default function PlayerActionBar({
  onOpenRoom,
  showRoomAction,
}: PlayerActionBarProps) {
  if (!showRoomAction) return null;

  return (
    <Paper variant="outlined" sx={{ mt: 1.5, p: 1 }}>
      <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
        <Button startIcon={<MeetingRoom />} onClick={onOpenRoom}>
          Room
        </Button>
      </Stack>
    </Paper>
  );
}
