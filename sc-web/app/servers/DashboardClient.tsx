"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Box,
  Button as MuiButton,
  Card,
  CardActions,
  CardContent,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  CloudDoneOutlined,
  CloudOffOutlined,
  ErrorOutlined,
  ExpandLess,
  ExpandMore,
  GamesOutlined,
  MoreVert,
  PeopleOutlined,
  RouterOutlined,
  SystemUpdateAlt,
} from "@mui/icons-material";
import { Button } from "@/components/ui";
import ServerPanel from "./ServerPanel";
import InviteManager from "./InviteManager";
import { timeAgo, csrfHeaders } from "./dashboard-utils";
import { probeLanHealth, type LanProbeResult } from "@/lib/lan/probe";
import { runServerUpgrade, type ServerUpdateState } from "@/lib/server-upgrade-client";

interface Membership {
  id: string;
  name: string;
  lastSeenAt: string | null;
  role: string;
}

type Health = "online" | "idle" | "offline";

interface ServerSummary {
  serverId: string;
  role: string;
  health: Health;
  lastSeenAt: string | null;
  installedVersion: string | null;
  activeSessionCount: number;
  gameCount: number;
  lan: { configured: boolean; healthUrls: string[] };
  activeUpgrade: { commandId: string; status: "pending" | "leased" } | null;
}

interface Props {
  memberships: Membership[];
}

interface UpdateView {
  state: "idle" | ServerUpdateState;
  message: string | null;
}

const healthOrder: Record<Health, number> = { offline: 0, idle: 1, online: 2 };
const healthColor: Record<Health, "success" | "warning" | "error"> = {
  online: "success",
  idle: "warning",
  offline: "error",
};

function plural(value: number, noun: string) {
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

export default function DashboardClient({ memberships }: Props) {
  const router = useRouter();
  const [summaries, setSummaries] = useState<Record<string, ServerSummary>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Membership | null>(null);
  const [editName, setEditName] = useState("");
  const [deleting, setDeleting] = useState<Membership | null>(null);
  const [updateTarget, setUpdateTarget] = useState<Membership | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [inviteTarget, setInviteTarget] = useState<Membership | null>(null);
  const [menuTarget, setMenuTarget] = useState<Membership | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [updates, setUpdates] = useState<Record<string, UpdateView>>({});
  const [lanProbeByServer, setLanProbeByServer] = useState<Record<string, LanProbeResult>>({});
  const resumedCommands = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;

    async function loadSummaries() {
      try {
        const response = await fetch("/api/servers/summary");
        if (!response.ok) throw new Error("Unable to load server health.");
        const data = await response.json() as { servers?: ServerSummary[] };
        if (cancelled) return;

        const next = Object.fromEntries((data.servers ?? []).map((summary) => [summary.serverId, summary]));
        setSummaries(next);

        const probes = await Promise.all((data.servers ?? []).map(async (summary) => {
          if (!summary.lan.healthUrls.length) return [summary.serverId, { reachable: false, reason: "no_urls" } as LanProbeResult] as const;
          return [summary.serverId, await probeLanHealth(summary.lan.healthUrls, { timeoutMs: 1_200 })] as const;
        }));
        if (!cancelled) setLanProbeByServer(Object.fromEntries(probes));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load server health.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSummaries();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    for (const summary of Object.values(summaries)) {
      const active = summary.activeUpgrade;
      if (!active || resumedCommands.current.has(active.commandId)) continue;
      resumedCommands.current.add(active.commandId);
      setUpdates((current) => ({
        ...current,
        [summary.serverId]: {
          state: active.status === "pending" ? "queued" : "running",
          message: active.status === "pending" ? "Update queued; waiting for the server…" : "Update in progress…",
        },
      }));
      void runServerUpgrade(summary.serverId, csrfHeaders(), (state, message) => {
        setUpdates((current) => ({ ...current, [summary.serverId]: { state, message } }));
      }, fetch, undefined, active.commandId);
    }
  }, [summaries]);

  const sorted = [...memberships].sort((a, b) => {
    const aHealth = summaries[a.id]?.health ?? "offline";
    const bHealth = summaries[b.id]?.health ?? "offline";
    return healthOrder[aHealth] - healthOrder[bHealth];
  });
  const attentionCount = sorted.filter((membership) => (summaries[membership.id]?.health ?? "offline") !== "online").length;

  async function generatePairingCode() {
    setPairingError(null);
    setPairingCode(null);
    try {
      const response = await fetch("/api/auth/pair/generate", { method: "POST", headers: csrfHeaders() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setPairingCode(data.code);
    } catch (cause) {
      setPairingError(cause instanceof Error ? cause.message : "Generate failed");
    }
  }

  async function requestUpdate(serverId: string) {
    setUpdateTarget(null);
    setUpdates((current) => ({ ...current, [serverId]: { state: "queued", message: "Preparing update…" } }));
    await runServerUpgrade(serverId, csrfHeaders(), (state, message) => {
      setUpdates((current) => ({ ...current, [serverId]: { state, message } }));
    });
  }

  async function doRename() {
    if (!editing || !editName.trim()) return;
    setError(null);
    try {
      const response = await fetch(`/api/servers/${editing.id}`, {
        method: "PATCH",
        headers: csrfHeaders(),
        body: JSON.stringify({ name: editName.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setEditing(null);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Rename failed");
    }
  }

  async function doDelete() {
    if (!deleting || deleteConfirm !== "DELETE") return;
    setError(null);
    try {
      const response = await fetch(`/api/servers/${deleting.id}`, { method: "DELETE", headers: csrfHeaders() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setDeleting(null);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Remove failed");
    }
  }

  function openMenu(event: React.MouseEvent<HTMLElement>, membership: Membership) {
    setMenuAnchor(event.currentTarget);
    setMenuTarget(membership);
  }

  function closeMenu() {
    setMenuAnchor(null);
    setMenuTarget(null);
  }

  function startRename(membership: Membership) {
    closeMenu();
    setEditing(membership);
    setEditName(membership.name);
  }

  function updateButton(summary: ServerSummary | undefined, update: UpdateView) {
    if (!summary) return { label: "Loading status…", disabled: true };
    if (update.state === "queued") return { label: "Update queued", disabled: true };
    if (update.state === "running") return { label: "Updating…", disabled: true };
    if (update.state === "done") return { label: "Restarting…", disabled: true };
    if (summary.activeSessionCount > 0) return { label: "Finish active game to update", disabled: true };
    if (summary.health === "offline") return { label: "Server offline", disabled: true };
    if (update.state === "failed") return { label: "Retry update", disabled: false };
    return { label: "Update server", disabled: false };
  }

  return (
    <Box component="section" aria-labelledby="servers-heading">
      {error && <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>}

      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mb: 3, justifyContent: "space-between", alignItems: { xs: "stretch", sm: "flex-start" } }}>
        <Box>
          <Typography id="servers-heading" component="h2" variant="h4" sx={{ mb: 0.75 }}>Server health</Typography>
          <Typography color="text.secondary">A clear view of availability, activity, and software maintenance.</Typography>
        </Box>
        <Button variant="secondary" size="sm" onClick={generatePairingCode}>Add server</Button>
      </Stack>

      {pairingCode && (
        <Paper variant="outlined" sx={{ mb: 3, p: 2.5, borderColor: "primary.main" }}>
          <Typography variant="overline" color="text.secondary">Pairing code</Typography>
          <Typography component="code" variant="h6" color="success.main" sx={{ display: "block", letterSpacing: "0.15em", mb: 1 }}>{pairingCode}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Run this on the machine with your ROMs:</Typography>
          <Paper component="code" variant="outlined" sx={{ display: "block", p: 1.5, bgcolor: "background.default", overflowWrap: "anywhere" }}>
            sc-server pair {pairingCode} --sc-web-url {window.location.origin}
          </Paper>
        </Paper>
      )}
      {pairingError && <Alert severity="error" sx={{ mb: 3 }}>Error: {pairingError}</Alert>}

      {!loading && attentionCount > 0 && (
        <Alert severity="warning" icon={<ErrorOutlined />} sx={{ mb: 3 }}>
          <Typography sx={{ fontWeight: 700 }}>Attention required</Typography>
          <Typography variant="body2">{plural(attentionCount, "server")} {attentionCount === 1 ? "needs" : "need"} attention. Servers requiring action are shown first.</Typography>
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" }, gap: 2.5 }} aria-label="Loading server health">
          {memberships.map((membership) => <Skeleton key={membership.id} variant="rounded" height={300} />)}
        </Box>
      ) : (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" }, gap: 2.5, alignItems: "start" }}>
          {sorted.map((membership) => {
            const summary = summaries[membership.id];
            const health = summary?.health ?? "offline";
            const isAdmin = membership.role === "admin";
            const isOpen = expanded.has(membership.id);
            const update = updates[membership.id] ?? { state: "idle", message: null };
            const updateAction = updateButton(summary, update);
            const lanProbe = lanProbeByServer[membership.id];
            const settingsRegionId = `server-settings-${membership.id}`;

            return (
              <Card
                key={membership.id}
                data-server-card={membership.id}
                variant="outlined"
                sx={{
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  borderColor: health === "online" ? "divider" : `${healthColor[health]}.main`,
                  boxShadow: health === "online" ? 0 : 2,
                  transition: (theme) => theme.transitions.create(["box-shadow", "border-color"]),
                }}
              >
                <CardContent sx={{ p: { xs: 2.25, sm: 3 }, flexGrow: 1 }}>
                  <Stack direction="row" spacing={1.5} sx={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
                        <Typography component="h3" variant="h5" sx={{ overflowWrap: "anywhere" }}>{membership.name}</Typography>
                        {membership.role === "member" && <Chip label="Shared with you" size="small" variant="outlined" />}
                      </Stack>
                      <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: "center" }}>
                        {health === "online" ? <CloudDoneOutlined color="success" fontSize="small" /> : <CloudOffOutlined color={healthColor[health]} fontSize="small" />}
                        <Chip label={health} size="small" color={healthColor[health]} variant="outlined" sx={{ textTransform: "capitalize" }} />
                        <Typography variant="body2" color="text.secondary">{summary?.lastSeenAt ? `Seen ${timeAgo(summary.lastSeenAt)}` : "No heartbeat yet"}</Typography>
                      </Stack>
                    </Box>
                    {isAdmin && (
                      <Tooltip title={`Manage ${membership.name}`}>
                        <IconButton aria-label={`Manage ${membership.name}`} onClick={(event) => openMenu(event, membership)}><MoreVert /></IconButton>
                      </Tooltip>
                    )}
                  </Stack>

                  <Divider sx={{ my: 2.5 }} />

                  <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 2 }}>
                    <Metric icon={<SystemUpdateAlt fontSize="small" />} label="Software" value={summary?.installedVersion ? `sc-server ${summary.installedVersion}` : "Version unavailable"} />
                    <Metric icon={<GamesOutlined fontSize="small" />} label="Library" value={summary ? plural(summary.gameCount, "game") : "Unavailable"} />
                    <Metric icon={<PeopleOutlined fontSize="small" />} label="Activity" value={summary ? plural(summary.activeSessionCount, "active session") : "Unavailable"} />
                    <Metric
                      icon={<RouterOutlined fontSize="small" />}
                      label="LAN path"
                      value={!summary?.lan.configured ? "Not advertised" : !lanProbe ? "Checking…" : lanProbe.reachable ? `${lanProbe.latencyMs.toFixed(0)} ms direct` : "Cloud fallback"}
                    />
                  </Box>

                  {isAdmin && summary && summary.activeSessionCount > 0 && (
                    <Alert severity="info" sx={{ mt: 2.5 }}>Updates pause until active games finish.</Alert>
                  )}
                  {update.message && (
                    <Alert role="status" aria-live="polite" severity={update.state === "failed" ? "error" : update.state === "done" ? "success" : "info"} sx={{ mt: 2.5 }}>
                      {update.message}
                    </Alert>
                  )}
                </CardContent>

                {isAdmin && (
                  <CardActions sx={{ px: { xs: 2.25, sm: 3 }, pb: 2.5, pt: 0, gap: 1, flexWrap: "wrap" }}>
                    <MuiButton
                      variant={update.state === "failed" ? "outlined" : "contained"}
                      startIcon={(update.state === "queued" || update.state === "running") ? <CircularProgress color="inherit" size={16} /> : <SystemUpdateAlt />}
                      disabled={updateAction.disabled}
                      onClick={() => setUpdateTarget(membership)}
                      sx={{ textTransform: "none" }}
                    >
                      {updateAction.label}
                    </MuiButton>
                    <MuiButton
                      variant="text"
                      endIcon={isOpen ? <ExpandLess /> : <ExpandMore />}
                      onClick={() => setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(membership.id)) next.delete(membership.id); else next.add(membership.id);
                        return next;
                      })}
                      aria-expanded={isOpen}
                      aria-controls={settingsRegionId}
                      sx={{ textTransform: "none" }}
                    >
                      {isOpen ? "Hide settings" : "Server settings"}
                    </MuiButton>
                  </CardActions>
                )}

                {isAdmin && (
                  <Collapse in={isOpen} unmountOnExit>
                    <Divider />
                    <Box id={settingsRegionId} role="region" aria-label={`${membership.name} advanced settings`} sx={{ p: { xs: 2.25, sm: 3 }, bgcolor: "action.hover" }}>
                      <Typography variant="h6" sx={{ mb: 0.75 }}>Advanced server settings</Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>Diagnostics and emulator core overrides for {membership.name}.</Typography>
                      <ServerPanel serverId={membership.id} />
                    </Box>
                  </Collapse>
                )}
              </Card>
            );
          })}
        </Box>
      )}

      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
        <MenuItem onClick={() => menuTarget && startRename(menuTarget)}>Rename server</MenuItem>
        <MenuItem onClick={() => { const target = menuTarget; closeMenu(); setInviteTarget(target); }}>Invite members</MenuItem>
        <Divider />
        <MenuItem sx={{ color: "error.main" }} onClick={() => { const target = menuTarget; closeMenu(); setDeleteConfirm(""); setDeleting(target); }}>Remove server</MenuItem>
      </Menu>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} fullWidth maxWidth="xs">
        <DialogTitle>Rename server</DialogTitle>
        <DialogContent>
          <TextField autoFocus fullWidth label="Server name" value={editName} onChange={(event) => setEditName(event.target.value)} sx={{ mt: 1 }} onKeyDown={(event) => { if (event.key === "Enter") void doRename(); }} />
        </DialogContent>
        <DialogActions><MuiButton onClick={() => setEditing(null)}>Cancel</MuiButton><MuiButton variant="contained" onClick={doRename}>Save</MuiButton></DialogActions>
      </Dialog>

      <Dialog open={updateTarget !== null} onClose={() => setUpdateTarget(null)} fullWidth maxWidth="sm">
        <DialogTitle>Update {updateTarget?.name}?</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            The server will restart. Players will be unable to launch games until it reconnects.
          </Alert>
          <Typography color="text.secondary">
            The dashboard will keep showing queued, updating, and restarting status after you confirm.
          </Typography>
        </DialogContent>
        <DialogActions>
          <MuiButton onClick={() => setUpdateTarget(null)}>Cancel</MuiButton>
          <MuiButton variant="contained" startIcon={<SystemUpdateAlt />} onClick={() => updateTarget && void requestUpdate(updateTarget.id)}>
            Update server
          </MuiButton>
        </DialogActions>
      </Dialog>

      <Dialog open={inviteTarget !== null} onClose={() => setInviteTarget(null)} maxWidth="md" fullWidth aria-labelledby="invite-dialog-title">
        <DialogTitle id="invite-dialog-title">Invite users to {inviteTarget?.name}</DialogTitle>
        <DialogContent dividers>{inviteTarget && <InviteManager serverId={inviteTarget.id} canManage={inviteTarget.role === "admin"} />}</DialogContent>
        <DialogActions><MuiButton onClick={() => setInviteTarget(null)}>Close</MuiButton></DialogActions>
      </Dialog>

      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} fullWidth maxWidth="sm">
        <DialogTitle>Remove {deleting?.name}</DialogTitle>
        <DialogContent>
          <Alert severity="error" sx={{ mb: 2 }}>This permanently deletes the server, its cached library, sessions, and commands.</Alert>
          <TextField autoFocus fullWidth label="Type DELETE to confirm" value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} />
        </DialogContent>
        <DialogActions><MuiButton onClick={() => setDeleting(null)}>Cancel</MuiButton><MuiButton color="error" variant="contained" disabled={deleteConfirm !== "DELETE"} onClick={doDelete}>Remove server</MuiButton></DialogActions>
      </Dialog>
    </Box>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1.25} sx={{ minWidth: 0 }}>
      <Box sx={{ color: "text.secondary", mt: 0.25, flexShrink: 0 }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>{label}</Typography>
        <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>{value}</Typography>
      </Box>
    </Stack>
  );
}
