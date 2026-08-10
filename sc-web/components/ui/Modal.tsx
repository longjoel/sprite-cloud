"use client";

import { useId } from "react";
import { Close } from "@mui/icons-material";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  type DialogProps,
} from "@mui/material";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** If true, clicking backdrop closes modal (default: true) */
  backdropClose?: boolean;
  width?: number;
}

export default function Modal({
  open,
  onClose,
  title,
  children,
  backdropClose = true,
  width = 400,
}: ModalProps) {
  const titleId = useId();
  const handleClose: DialogProps["onClose"] = (_event, reason) => {
    if (!backdropClose && reason === "backdropClick") return;
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      aria-labelledby={title ? titleId : undefined}
      slotProps={{
        paper: {
          sx: {
            minWidth: 320,
            maxWidth: width,
            borderRadius: 1,
            border: 1,
            borderColor: "divider",
          },
        },
      }}
    >
      {title && (
        <DialogTitle id={titleId} sx={{ pr: 6 }}>
          {title}
          <IconButton
            aria-label="Close dialog"
            onClick={onClose}
            size="small"
            sx={{ position: "absolute", right: 12, top: 12 }}
          >
            <Close fontSize="inherit" />
          </IconButton>
        </DialogTitle>
      )}
      <DialogContent>{children}</DialogContent>
    </Dialog>
  );
}
