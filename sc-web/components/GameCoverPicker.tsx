"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  Divider, IconButton, Paper, Stack, Tab, Tabs, TextField, ToggleButton, ToggleButtonGroup,
  Typography, useMediaQuery, useTheme,
} from "@mui/material";
import { CheckCircle, Close, CloudUploadOutlined, ImageSearchOutlined } from "@mui/icons-material";
import { csrfHeaders } from "@/components/library-utils";

export interface CoverPickerGame {
  id: string;
  serverId: string;
  name: string;
  platform: string;
  coverUrl?: string | null;
}
interface Props { open: boolean; game: CoverPickerGame; serverName: string; onClose: () => void; onSaved: (coverUrl: string) => void; }
type ArtworkType = "boxart" | "title" | "screenshot";
interface Candidate { id: string; type: ArtworkType; title: string; previewUrl: string; attribution: string; }
interface StateResponse { override: { coverUrl: string } | null; defaultCoverUrl: string; capabilities: { configured: boolean; canManage: boolean }; }

export default function GameCoverPicker({ open, game, serverName, onClose, onSaved }: Props) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const [tab, setTab] = useState<"retroarch" | "upload">("retroarch");
  const [type, setType] = useState<ArtworkType>("boxart");
  const [search, setSearch] = useState(game.name);
  const [state, setState] = useState<StateResponse | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [upload, setUpload] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState(false);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const candidateRequest = useRef(0);
  const base = `/api/servers/${encodeURIComponent(game.serverId)}/games/${encodeURIComponent(game.id)}/cover`;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const requestId = ++candidateRequest.current;
    setSearch(game.name); setState(null); setCandidates([]); setSelected(null); setUpload(null); setSettingsError(null); setError(null); setLoadingState(true); setLoadingCandidates(true);
    void (async () => {
      try {
        const stateResponse = await fetch(base);
        if (!stateResponse.ok) throw new Error("Could not load cover settings.");
        const nextState = await stateResponse.json() as StateResponse;
        if (!cancelled) setState(nextState);
      } catch (cause) { if (!cancelled) setSettingsError(cause instanceof Error ? cause.message : "Could not load cover settings."); }
      finally { if (!cancelled) setLoadingState(false); }
    })();
    void (async () => {
      try {
        const response = await fetch(`${base}/candidates?type=boxart&q=${encodeURIComponent(game.name)}`);
        const body = await response.json() as { candidates?: Candidate[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "Artwork search failed.");
        if (!cancelled && requestId === candidateRequest.current) setCandidates(body.candidates ?? []);
      } catch (cause) { if (!cancelled && requestId === candidateRequest.current) setError(cause instanceof Error ? cause.message : "Artwork search failed."); }
      finally { if (!cancelled && requestId === candidateRequest.current) setLoadingCandidates(false); }
    })();
    return () => { cancelled = true; };
  }, [base, game.name, open, retryVersion]);

  useEffect(() => () => { if (uploadPreview) URL.revokeObjectURL(uploadPreview); }, [uploadPreview]);

  async function loadCandidates(nextType = type) {
    const requestId = ++candidateRequest.current;
    setLoadingCandidates(true); setError(null);
    try {
      const response = await fetch(`${base}/candidates?type=${nextType}&q=${encodeURIComponent(search.trim())}`);
      const body = await response.json() as { candidates?: Candidate[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Artwork search failed.");
      if (requestId === candidateRequest.current) { setCandidates(body.candidates ?? []); setSelected(null); }
    } catch (cause) { if (requestId === candidateRequest.current) setError(cause instanceof Error ? cause.message : "Artwork search failed."); }
    finally { if (requestId === candidateRequest.current) setLoadingCandidates(false); }
  }

  function chooseFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setError("Cover art must be 10 MB or smaller."); return; }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { setError("Choose a PNG, JPEG, WebP, or GIF image."); return; }
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    setUpload(file); setUploadPreview(URL.createObjectURL(file)); setSelected(null); setError(null);
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      const response = tab === "upload" && upload
        ? await fetch(base, { method: "POST", headers: csrfHeaders(false), body: upload })
        : await fetch(base, { method: "PUT", headers: csrfHeaders(), body: JSON.stringify({ candidateId: selected?.id }) });
      const body = await response.json() as { override?: { coverUrl: string }; error?: string };
      if (!response.ok || !body.override) throw new Error(body.error ?? "Cover could not be saved.");
      onSaved(body.override.coverUrl); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Cover could not be saved."); }
    finally { setSaving(false); }
  }

  async function reset() {
    setSaving(true); setError(null);
    try {
      const response = await fetch(base, { method: "DELETE", headers: csrfHeaders(false) });
      const body = await response.json() as { coverUrl?: string; error?: string };
      if (!response.ok || !body.coverUrl) throw new Error(body.error ?? "Default cover could not be restored.");
      onSaved(body.coverUrl); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Default cover could not be restored."); }
    finally { setSaving(false); }
  }

  const chosenUrl = useMemo(() => uploadPreview ?? selected?.previewUrl ?? state?.override?.coverUrl ?? game.coverUrl ?? state?.defaultCoverUrl, [game.coverUrl, selected, state, uploadPreview]);
  const canSave = !saving && !!state?.capabilities.configured && ((tab === "retroarch" && !!selected) || (tab === "upload" && !!upload));

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullScreen={fullScreen} fullWidth maxWidth="lg" aria-labelledby="cover-picker-title"
      slotProps={{ paper: { sx: { height: { sm: "min(790px, calc(100vh - 64px))" }, borderRadius: 0 } } }}>
      <DialogTitle component="div" id="cover-picker-title" sx={{ borderBottom: 1, borderColor: "divider", pr: 7 }}>
        <Typography variant="overline" color="primary.main">{serverName} · {game.platform}</Typography>
        <Typography variant="h5">Change cover for {game.name}</Typography>
        <Typography variant="body2" color="text.secondary">Choose artwork everyone on this server will see.</Typography>
        <IconButton aria-label="Close cover picker" onClick={onClose} disabled={saving} sx={{ position: "absolute", right: 12, top: 12 }}><Close /></IconButton>
      </DialogTitle>
      <DialogContent sx={{ p: 0, display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1fr) 310px" }, minHeight: 0 }}>
        <Box sx={{ p: { xs: 2, sm: 3 }, overflow: "auto" }}>
          {settingsError && <Alert severity="error" role="alert" action={<Button color="inherit" size="small" onClick={() => setRetryVersion((value) => value + 1)}>Retry</Button>} sx={{ mb: 2 }}>{settingsError}</Alert>}
          {error && <Alert severity="error" role="alert" action={<Button color="inherit" size="small" onClick={() => void loadCandidates()}>Retry search</Button>} sx={{ mb: 2 }}>{error}</Alert>}
          {state && !state.capabilities.configured && <Alert severity="warning" sx={{ mb: 2 }}>Cover storage is not configured. Browsing remains available, but saving is disabled until GV_COVER_OVERRIDES_DIR is set.</Alert>}
          <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile sx={{ mb: 2 }}>
            <Tab value="retroarch" icon={<ImageSearchOutlined />} iconPosition="start" aria-label="RetroArch artwork" label={<><Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>RetroArch</Box><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>RetroArch artwork</Box></>} />
            <Tab value="upload" icon={<CloudUploadOutlined />} iconPosition="start" aria-label="Upload my own artwork" label={<><Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>Upload</Box><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>Upload my own</Box></>} disabled={!state?.capabilities.configured} />
          </Tabs>
          {tab === "retroarch" ? <>
            <Stack spacing={1} sx={{ mb: 1.5, flexDirection: { xs: "column", sm: "row" } }}>
              <TextField fullWidth size="small" label="Search artwork" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void loadCandidates(); }} />
              <Button variant="outlined" onClick={() => void loadCandidates()} disabled={loadingCandidates}>Search</Button>
            </Stack>
            <ToggleButtonGroup exclusive value={type} size="small" onChange={(_, value) => { if (value) { setType(value); void loadCandidates(value); } }} sx={{ mb: 2, flexWrap: "wrap" }}>
              <ToggleButton value="boxart">Box art</ToggleButton><ToggleButton value="title">Title screens</ToggleButton><ToggleButton value="screenshot">Screenshots</ToggleButton>
            </ToggleButtonGroup>
            {loadingCandidates ? <Stack sx={{ py: 8, alignItems: "center" }}><CircularProgress aria-label="Loading artwork" /></Stack>
              : candidates.length === 0 ? <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}><Typography color="text.secondary">No matching RetroArch artwork. Try another title or upload your own.</Typography></Paper>
              : <Box role="radiogroup" aria-label="RetroArch artwork candidates" sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(3, minmax(0, 1fr))", sm: "repeat(4, minmax(120px, 1fr))" }, gap: 1.5 }}>
                {candidates.map((candidate) => <Paper key={candidate.id} component="label" variant="outlined" sx={{ p: 0, position: "relative", overflow: "hidden", cursor: "pointer", borderWidth: 2, borderColor: selected?.id === candidate.id ? "primary.main" : "divider", bgcolor: "background.default", color: "text.primary", "&:has(input:focus-visible)": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }}>
                  <Box component="input" type="radio" name="cover-candidate" value={candidate.id} checked={selected?.id === candidate.id} onChange={() => setSelected(candidate)} aria-label={`${candidate.title}, ${candidate.attribution}`} sx={{ position: "absolute", opacity: 0, width: 1, height: 1 }} />
                  <Box component="img" src={candidate.previewUrl} alt="" sx={{ width: "100%", aspectRatio: "3 / 4", objectFit: "cover", display: "block", bgcolor: "action.hover" }} />
                  {selected?.id === candidate.id && <CheckCircle color="primary" sx={{ position: "absolute", top: 6, right: 6, bgcolor: "background.paper", borderRadius: "50%" }} />}
                  <Box sx={{ p: 1, minWidth: 0 }}><Typography variant="caption" noWrap sx={{ display: "block", fontWeight: 700 }}>{candidate.title}</Typography><Typography variant="caption" color="text.secondary">{candidate.attribution}</Typography></Box>
                </Paper>)}
              </Box>}
          </> : <Box onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }}
            sx={{ minHeight: 300, border: "1px dashed", borderColor: dragging ? "primary.main" : "divider", bgcolor: dragging ? "action.hover" : "background.default", display: "grid", placeItems: "center", textAlign: "center", p: 4 }}>
            <Stack spacing={1} sx={{ alignItems: "center" }}><CloudUploadOutlined color="primary" sx={{ fontSize: 56 }} /><Typography variant="h6">Drop cover art here</Typography><Typography color="text.secondary">PNG, JPEG, WebP, or animated GIF · up to 10 MB</Typography><Button variant="outlined" onClick={() => inputRef.current?.click()}>Choose file</Button><input ref={inputRef} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => chooseFile(event.target.files?.[0])} /></Stack>
          </Box>}
        </Box>
        <Box component="aside" sx={{ p: 3, bgcolor: "background.default", borderLeft: { md: 1 }, borderTop: { xs: 1, md: 0 }, borderColor: "divider", overflow: "auto" }}>
          {loadingState && <CircularProgress size={20} aria-label="Loading cover settings" sx={{ mb: 1 }} />}
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>Preview in your library</Typography>
          <Stack direction="row" spacing={1}>
            {[{ label: "Current", url: game.coverUrl }, { label: "New cover", url: chosenUrl }].map(({ label, url }) => <Box key={label} sx={{ flex: 1, minWidth: 0 }}><Typography variant="caption" color={label === "New cover" ? "primary.main" : "text.secondary"}>{label}</Typography><Box sx={{ mt: .5, aspectRatio: "3 / 4", border: 1, borderColor: label === "New cover" ? "primary.main" : "divider", bgcolor: "action.hover", overflow: "hidden" }}>{url && <Box component="img" src={url} alt={`${label} artwork for ${game.name}`} sx={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}</Box></Box>)}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>This replaces the default for every member of {serverName}. The same game on other servers is unaffected.</Typography>
          <Divider sx={{ my: 2 }} /><Typography variant="caption" color="primary.main">SERVER-WIDE OVERRIDE</Typography><Typography variant="subtitle2">{serverName}</Typography>
        </Box>
      </DialogContent>
      <DialogActions sx={{ borderTop: 1, borderColor: "divider", p: 2 }}>
        {state?.override && <Button color="inherit" onClick={() => void reset()} disabled={saving} sx={{ mr: "auto", px: { xs: 1, sm: 2 } }}><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>Use default cover</Box><Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>Default</Box></Button>}
        <Button color="inherit" onClick={onClose} disabled={saving}>Cancel</Button><Button variant="contained" onClick={() => void save()} disabled={!canSave}>{saving ? "Saving…" : "Save cover"}</Button>
      </DialogActions>
    </Dialog>
  );
}
