"use client";

import { useState, type ReactNode, type RefObject } from "react";
import { useSession } from "next-auth/react";
import {
  Alert,
  Box,
  Chip,
  Container,
  Divider,
  Drawer,
  Paper,
  Stack,
  Tab,
  Tabs,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import AppHeader from "@/components/fluent/AppHeader";
import GameStage from "@/components/player/GameStage";
import PlayerActionBar from "@/components/player/PlayerActionBar";

interface PlayerWorkspaceProps {
  children: ReactNode;
  gameName: string;
  platform?: string;
  isFullscreen: boolean;
  isLanProxy: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
}

function RoomSummary() {
  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Box>
        <Typography variant="h6">Room</Typography>
        <Typography variant="body2" color="text.secondary">
          Your live session workspace
        </Typography>
      </Box>
      <Divider />
      <Alert severity="info" variant="outlined">
        Use Options to access save/load, controls, sharing, display, and diagnostics for this session.
      </Alert>
    </Stack>
  );
}

export default function PlayerWorkspace({
  children,
  gameName,
  platform,
  isFullscreen,
  isLanProxy,
  stageRef,
}: PlayerWorkspaceProps) {
  const theme = useTheme();
  const { data: session } = useSession();
  const compactWorkspace = useMediaQuery(theme.breakpoints.down("md"));
  const [roomOpen, setRoomOpen] = useState(false);

  return (
    <Box
      data-player-workspace={isFullscreen ? "fullscreen" : "room"}
      sx={{ minHeight: "100dvh", bgcolor: "background.default", color: "text.primary" }}
    >
      <AppHeader
        userName={session?.user?.name || session?.user?.email}
        authenticated={Boolean(session)}
        isLanProxy={isLanProxy}
      />
      <Container component="main" maxWidth="xl" sx={{ py: { xs: 1.5, sm: 2.5 } }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1}
          sx={{ alignItems: { xs: "flex-start", sm: "center" }, mb: 1.5 }}
        >
          <Typography component="h1" variant="h5" sx={{ flexGrow: 1, minWidth: 0 }} noWrap>
            {gameName}
          </Typography>
          {platform && <Chip label={platform} size="small" variant="outlined" />}
          <Chip label="Room view" size="small" color="primary" />
        </Stack>

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 3fr) minmax(280px, 1fr)" },
            gap: 2,
            alignItems: "start",
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <GameStage ref={stageRef}>{children}</GameStage>
            <PlayerActionBar
              onOpenRoom={() => setRoomOpen(true)}
              showRoomAction={compactWorkspace}
            />
          </Box>

          {!compactWorkspace && (
            <Paper component="aside" variant="outlined" aria-label="Room workspace">
              <Tabs value="room" aria-label="Room workspace sections">
                <Tab value="room" label="Room" />
              </Tabs>
              <RoomSummary />
            </Paper>
          )}
        </Box>
      </Container>

      <Drawer
        anchor="bottom"
        open={compactWorkspace && roomOpen}
        onClose={() => setRoomOpen(false)}
        slotProps={{
          paper: {
            sx: {
              maxHeight: "min(70dvh, 560px)",
              borderTopLeftRadius: 8,
              borderTopRightRadius: 8,
              pb: "env(safe-area-inset-bottom, 0px)",
            },
          },
        }}
      >
        <Tabs value="room" aria-label="Room workspace sections">
          <Tab value="room" label="Room" />
        </Tabs>
        <RoomSummary />
      </Drawer>
    </Box>
  );
}
