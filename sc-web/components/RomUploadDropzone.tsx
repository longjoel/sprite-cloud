"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  LinearProgress,
  Typography,
  List,
  ListItemButton,
  ListItemText,
  Chip,
  Box,
  IconButton,
} from "@mui/material";
import {
  CloudUpload,
  Close,
  CheckCircle,
  Error as ErrorIcon,
  InsertDriveFile,
  Dns,
} from "@mui/icons-material";
import { RomTransferClient, type TransferCredentials, type TransferPhase } from "@/lib/rom-transfer-client";

// ── Types ──────────────────────────────────────────────────────────────

interface ServerInfo {
  id: string;
  name: string;
  status: string;
}

interface UploadEntry {
  file: File;
  state: "queued" | "uploading" | "done" | "error";
  progress: number; // bytes sent
  total: number;
  error?: string;
  result?: { hash: string; size: number; game_id: string | null };
}

interface RomUploadDropzoneProps {
  /** Servers where the user is admin and the server is online. */
  adminServers: ServerInfo[];
  /** Called after a successful upload commits (so the library can refresh). */
  onUploadComplete?: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────

const ROM_EXTENSIONS = new Set([
  ".nes", ".sfc", ".smc", ".n64", ".z64", ".v64",
  ".gb", ".gbc", ".gba", ".nds",
  ".gen", ".md", ".smd", ".sms", ".gg", ".32x",
  ".iso", ".cue", ".chd", ".bin", ".cso",
  ".pce", ".ngp", ".ngc", ".ws", ".wsc",
  ".a26", ".a52", ".a78", ".lnx",
  ".vb", ".min", ".cdi", ".gdi", ".fds", ".zip",
]);

function isRomFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return ROM_EXTENSIONS.has(name.slice(name.lastIndexOf(".")));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatThroughput(bytesPerSec: number): string {
  return `${formatSize(bytesPerSec)}/s`;
}

async function csrfHeaders(): Promise<Record<string, string>> {
  let token = document.cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("sc_csrf_token="))
    ?.split("=")
    .slice(1)
    .join("=") ?? "";
  if (!token) {
    token = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
    document.cookie = `sc_csrf_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  }
  return { "Content-Type": "application/json", "x-csrf-token": decodeURIComponent(token) };
}

/** Request transfer credentials from the auth endpoint. */
async function requestTransfer(
  serverId: string,
  basename: string,
  size: number,
): Promise<TransferCredentials> {
  const resp = await fetch(`/api/servers/${encodeURIComponent(serverId)}/rom-transfers`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify({ basename, declared_size: size }),
  });
  if (!resp.ok) {
    const err = (await resp.json()) as { error?: string };
    throw new Error(err.error ?? `Transfer authorization failed (HTTP ${resp.status})`);
  }
  return (await resp.json()) as TransferCredentials;
}

// ── Component ──────────────────────────────────────────────────────────

export default function RomUploadDropzone({
  adminServers,
  onUploadComplete,
}: RomUploadDropzoneProps) {
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<UploadEntry[]>([]);
  const [serverOpen, setServerOpen] = useState(false);
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [phase, setPhase] = useState<TransferPhase | "idle">("idle");
  const dragCounter = useRef(0);
  const abortRef = useRef<RomTransferClient | null>(null);

  // ── Drag-and-drop handlers ────────────────────────────────────────

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer?.types.includes("Files")) {
      setDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragging(false);
    }
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragging(false);

    const droppedFiles = Array.from(e.dataTransfer?.files ?? [])
      .filter(isRomFile);

    if (droppedFiles.length === 0) return;

    setFiles(droppedFiles.map((f) => ({
      file: f,
      state: "queued" as const,
      progress: 0,
      total: f.size,
    })));

    if (adminServers.length === 1) {
      setSelectedServer(adminServers[0].id);
    } else {
      setServerOpen(true);
    }
  }, [adminServers]);

  // Wire global drag events
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => handleDragEnter(e);
    const onDragLeave = (e: DragEvent) => handleDragLeave(e);
    const onDragOver = (e: DragEvent) => { e.preventDefault(); };
    const onDrop = (e: DragEvent) => handleDrop(e);

    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);

    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [handleDragEnter, handleDragLeave, handleDrop]);

  // ── File input handler ────────────────────────────────────────────

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []).filter(isRomFile);
    if (selected.length === 0) return;

    setFiles(selected.map((f) => ({
      file: f,
      state: "queued" as const,
      progress: 0,
      total: f.size,
    })));

    if (adminServers.length === 1) {
      setSelectedServer(adminServers[0].id);
    } else {
      setServerOpen(true);
    }
  }, [adminServers]);

  // ── Upload flow ───────────────────────────────────────────────────

  const startUpload = useCallback(async () => {
    if (!selectedServer || files.length === 0) return;
    setServerOpen(false);

    const updated = [...files];
    for (let i = 0; i < updated.length; i++) {
      const entry = updated[i];
      if (entry.state === "done") continue;

      updated[i] = { ...entry, state: "uploading" as const };
      setFiles([...updated]);

      try {
        setPhase("signaling");

        // 1. Get transfer credentials
        const creds = await requestTransfer(selectedServer, entry.file.name, entry.file.size);

        // 2. Upload via WebRTC
        const client = new RomTransferClient(entry.file, creds, selectedServer);
        abortRef.current = client;

        client.onProgress = (sent, total) => {
          updated[i] = { ...updated[i], progress: sent };
          setFiles([...updated]);
        };

        client.onPhase = (p) => setPhase(p);

        const result = await client.upload();

        updated[i] = {
          ...updated[i],
          state: "done",
          progress: result.size,
          result,
        };
        setFiles([...updated]);

        onUploadComplete?.();
      } catch (err) {
        if (err instanceof Error && err.message === "Cancelled") {
          updated[i] = { ...updated[i], state: "queued" };
        } else {
          updated[i] = {
            ...updated[i],
            state: "error",
            error: err instanceof Error ? err.message : "Upload failed",
          };
        }
        setFiles([...updated]);
      }
    }

    setPhase("idle");
    abortRef.current = null;
  }, [selectedServer, files, onUploadComplete]);

  const cancelUpload = useCallback(() => {
    abortRef.current?.cancel();
  }, []);

  // ── Auto-start when server selected and files queued ──────────────

  useEffect(() => {
    if (selectedServer && files.length > 0 && files.some((f) => f.state === "queued")) {
      void startUpload();
    }
  }, [selectedServer, files.length, startUpload]);

  // ── Reset ─────────────────────────────────────────────────────────

  const clearFiles = useCallback(() => {
    cancelUpload();
    setFiles([]);
    setPhase("idle");
    setSelectedServer(null);
  }, [cancelUpload]);

  // ── Render ────────────────────────────────────────────────────────

  const hasActive = files.some((f) => f.state === "uploading");
  const totalProgress = files.reduce((sum, f) => sum + f.progress, 0);
  const totalSize = files.reduce((sum, f) => sum + f.total, 0);

  return (
    <>
      {/* Drag overlay */}
      {dragging && (
        <Box
          sx={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(10, 14, 26, 0.85)",
            border: "3px dashed #38bdf8",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 2,
            pointerEvents: "none",
          }}
        >
          <CloudUpload sx={{ fontSize: 64, color: "#38bdf8" }} />
          <Typography variant="h6" sx={{ color: "#38bdf8", fontFamily: "monospace" }}>
            Drop ROM files to upload
          </Typography>
        </Box>
      )}

      {/* Upload button — shown when no active uploads */}
      {!hasActive && files.length === 0 && (
        <Button
          variant="outlined"
          size="small"
          startIcon={<CloudUpload />}
          onClick={() => {
            if (adminServers.length === 0) return;
            if (adminServers.length === 1) {
              setSelectedServer(adminServers[0].id);
              // Open file picker
              document.getElementById("rom-file-input")?.click();
            } else {
              // Click to select files, server choice next
              document.getElementById("rom-file-input")?.click();
            }
          }}
          disabled={adminServers.length === 0}
          sx={{
            borderColor: "rgba(56,189,248,0.3)",
            color: "#38bdf8",
            fontFamily: "monospace",
            textTransform: "none",
            "&:hover": { borderColor: "#38bdf8", background: "rgba(56,189,248,0.08)" },
          }}
        >
          Upload ROMs
        </Button>
      )}

      <input
        id="rom-file-input"
        type="file"
        multiple
        accept={[...ROM_EXTENSIONS].join(",")}
        style={{ display: "none" }}
        onChange={handleFileSelect}
      />

      {/* Server selector */}
      <Dialog open={serverOpen} onClose={() => files.length === 0 && setServerOpen(false)}>
        <DialogTitle sx={{ fontFamily: "monospace", color: "#cbd5e1" }}>
          Select target server
        </DialogTitle>
        <DialogContent>
          <List>
            {adminServers.map((srv) => (
              <ListItemButton
                key={srv.id}
                onClick={() => { setSelectedServer(srv.id); }}
                sx={{
                  borderRadius: 1,
                  mb: 0.5,
                  "&:hover": { background: "rgba(56,189,248,0.08)" },
                }}
              >
                <Dns sx={{ mr: 1.5, color: srv.status === "online" ? "#22c55e" : "#94a3b8" }} />
                <ListItemText
                  sx={{ "& .MuiListItemText-primary": { fontFamily: "monospace", color: "#cbd5e1" } }}
                >
                  {srv.name}
                </ListItemText>
                <Chip
                  label={srv.status}
                  size="small"
                  sx={{
                    fontFamily: "monospace",
                    background: srv.status === "online" ? "rgba(34,197,94,0.15)" : "rgba(148,163,184,0.15)",
                    color: srv.status === "online" ? "#22c55e" : "#94a3b8",
                  }}
                />
              </ListItemButton>
            ))}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setServerOpen(false); setFiles([]); }} sx={{ color: "#94a3b8" }}>
            Cancel
          </Button>
        </DialogActions>
      </Dialog>

      {/* Upload progress panel */}
      {files.length > 0 && (
        <Box
          sx={{
            position: "fixed",
            bottom: 16,
            right: 16,
            width: 360,
            maxWidth: "90vw",
            background: "#111827",
            border: "1px solid #1e293b",
            borderRadius: 2,
            boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
            p: 2,
            zIndex: 1000,
          }}
        >
          {/* Header */}
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 1 }}>
            <Typography variant="subtitle2" sx={{ fontFamily: "monospace", color: "#cbd5e1" }}>
              {phase === "idle" ? "Upload queued" : phase}
            </Typography>
            <IconButton size="small" onClick={clearFiles} sx={{ color: "#94a3b8" }}>
              <Close fontSize="small" />
            </IconButton>
          </Box>

          {/* Overall progress */}
          {totalSize > 0 && (
            <Box sx={{ mb: 1 }}>
              <LinearProgress
                variant="determinate"
                value={totalSize > 0 ? (totalProgress / totalSize) * 100 : 0}
                sx={{
                  height: 4,
                  borderRadius: 2,
                  background: "#1e293b",
                  "& .MuiLinearProgress-bar": { background: "#38bdf8" },
                }}
              />
              <Typography variant="caption" sx={{ fontFamily: "monospace", color: "#94a3b8", mt: 0.5 }}>
                {formatSize(totalProgress)} / {formatSize(totalSize)}
                {hasActive && ` — ${phase}`}
              </Typography>
            </Box>
          )}

          {/* File list */}
          <Box sx={{ maxHeight: 200, overflow: "auto" }}>
            {files.map((entry, i) => (
              <Box
                key={`${entry.file.name}-${i}`}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  py: 0.5,
                  borderBottom: "1px solid #1e293b",
                }}
              >
                {entry.state === "done" ? (
                  <CheckCircle sx={{ fontSize: 16, color: "#22c55e" }} />
                ) : entry.state === "error" ? (
                  <ErrorIcon sx={{ fontSize: 16, color: "#ef4444" }} />
                ) : (
                  <InsertDriveFile sx={{ fontSize: 16, color: "#38bdf8" }} />
                )}

                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    variant="caption"
                    sx={{
                      fontFamily: "monospace",
                      color: entry.state === "error" ? "#ef4444" : "#cbd5e1",
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {entry.file.name}
                  </Typography>
                  <Typography variant="caption" sx={{ fontFamily: "monospace", color: "#64748b" }}>
                    {entry.state === "done"
                      ? formatSize(entry.total)
                      : `${formatSize(entry.progress)} / ${formatSize(entry.total)}`}
                    {entry.error && ` — ${entry.error}`}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>

          {/* Cancel button */}
          {hasActive && (
            <Button
              fullWidth
              size="small"
              variant="outlined"
              onClick={cancelUpload}
              sx={{
                mt: 1,
                borderColor: "rgba(239,68,68,0.3)",
                color: "#ef4444",
                fontFamily: "monospace",
                textTransform: "none",
              }}
            >
              Cancel upload
            </Button>
          )}
        </Box>
      )}
    </>
  );
}
