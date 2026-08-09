"use client";

import { Snackbar, Alert, type AlertColor } from "@mui/material";

interface ToastProps {
  /** Duration in ms before auto-dismiss. 0 = persistent. */
  duration?: number;
  /** Fire this after dismiss (for parent to clear state). */
  onDone?: () => void;
  variant?: "success" | "error";
  children: React.ReactNode;
}

export default function Toast({
  duration = 2000,
  onDone,
  variant = "success",
  children,
}: ToastProps) {
  const severity: AlertColor = variant;
  // success = polite (role=status), error = assertive (role=alert)
  const role = variant === "success" ? "status" : "alert";

  return (
    <Snackbar
      open
      autoHideDuration={duration || null}
      onClose={(_event, reason) => {
        if (reason === "clickaway") return;
        onDone?.();
      }}
      anchorOrigin={{ vertical: "top", horizontal: "center" }}
      sx={{ top: 64 }}
    >
      <Alert
        severity={severity}
        role={role}
        variant="outlined"
        onClose={onDone}
        sx={{ borderRadius: 1 }}
      >
        {children}
      </Alert>
    </Snackbar>
  );
}
