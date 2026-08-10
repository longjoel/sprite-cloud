import Link from "next/link";
import { Box, CircularProgress, Paper, Typography } from "@mui/material";

interface LoadingPageProps {
  label?: string;
}

export default function LoadingPage({ label = "Loading…" }: LoadingPageProps) {
  return (
    <Box sx={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", p: 3 }}>
      <Paper sx={{ minWidth: 220, p: 3, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
        <CircularProgress aria-label={label} />
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      </Paper>
    </Box>
  );
}
