# Material UI Player-Room Workspace Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement this plan story-by-story with spec-compliance and code-quality review at each immutable PR HEAD.

**Goal:** Turn windowed play into a responsive Material UI room workspace for gameplay, presence, chat, saves, and session controls while preserving a game-only immersive fullscreen mode.

**Architecture:** Split the current monolithic player into a persistent application workspace around a specialized `GameStage`. MUI owns page structure, controls, panels, feedback, typography, spacing, colors, and breakpoints. Custom CSS remains only for video/canvas geometry, pixel rendering, fullscreen containment, safe areas, touch-controller rendering/hit regions, and immersive auto-hide behavior. Live presence and chat are runtime/DataChannel concerns; the cloud remains the authorization and signaling control plane, and bulk save bodies must not transit through `sc-web`.

**Tech stack:** Next.js 15, React 19, Material UI 9, WebRTC/DataChannels, Rust `sc-server`, Vitest/jsdom, browser E2E, Cargo tests.

**Program lineage:** Successor to completed UI/UX epic #560. Builds on the neutral Material UI baseline merged in PR #787 and the shared navigation policy in PR #792.

## Tracked program

- Epic: #793 — Build the Material UI player-room workspace
- #794 — MUI player workspace and scoped fullscreen stage
- #795 — MUI player controls and panel consolidation
- #796 — authoritative live room presence
- #797 — bounded ephemeral room chat
- #798 — MUI Save Center and safe save transfer
- #799 — responsive, accessibility, and integration closure

---

## Current state

- `sc-web/components/GamePlayer.tsx` owns transport startup, lifecycle, fullscreen, saves, sharing, overlays, controller settings, role-aware actions, and rendering in one component of roughly 1,000 lines.
- `sc-web/components/GamePlayer.module.css` makes the shell and video occupy `width: 100%; height: 100%`; therefore browser-windowed and fullscreen presentation are visually equivalent.
- `GamePlayer` calls `document.documentElement.requestFullscreen()`, so the whole document—not a scoped game stage—enters fullscreen.
- `OptionsOverlay`, save stack, room controls, remapping, and diagnostics are primarily blocking overlays over the video.
- Existing save operations are acknowledgment-driven runtime snapshot commands. Browser upload/download APIs for SRAM or snapshots do not yet exist.
- Durable peer-token rows prove authorization issuance, not live presence. Presence must come from the authenticated live DataChannel/peer lifecycle.
- MUI 9.2 and MUI Icons are installed. The ordinary application shell already uses a neutral dark Material theme.

## Material UI contract

### MUI owns

- Application layout: `Container`, `Box`, `Stack`, `Paper`
- Navigation and action controls: `Button`, `IconButton`, `Tooltip`, `Menu`, `MenuItem`
- Responsive secondary surfaces: `Tabs`, `Tab`, `Drawer`, `Dialog`
- Persistent room content: `List`, `ListItem`, `Avatar`, `Badge`, `Chip`, `Divider`
- Forms: `TextField`, `FormHelperText`, `FormControlLabel`, native input through MUI slot/component contracts
- Save history: `TableContainer`, `Table`, `TableHead`, `TableBody`, `TableRow`, `TableCell`; responsive `List` alternative
- Feedback: `Alert`, `Snackbar`, `Skeleton`, `CircularProgress`, `LinearProgress`
- Theme roles and spacing through `sx` and `theme`

### Specialized CSS owns

- `<video>`/canvas dimensions and `object-fit`
- Source aspect ratio and pixel rendering
- Fullscreen stage selectors and safe areas
- Touch-controller visual layer and bounded hit regions
- Immersive auto-hiding chrome

### Rules

1. No new hard-coded colors in ordinary UI when a theme role exists.
2. Use MUI Icons rather than emoji for permanent controls.
3. Use `Paper` for persistent workspace regions; reserve `Card` for independently actionable content.
4. Preserve semantic elements and accessibility contracts; do not mechanically replace every element with `Box`.
5. Put responsive layout values in `sx`; installed MUI v9 typings may reject some responsive props directly on `Stack` or `Typography`.
6. Do not recreate MUI button, modal, menu, field, or feedback behavior in page-local CSS.
7. MUI portals used while the game stage is fullscreen must target the fullscreen stage container or disable the portal so the panel remains visible.
8. Host/player/spectator enforcement remains server-authoritative; disabled or hidden UI is never the permission boundary.

## Security and authority model

| Threat | Mitigation | Stories |
|---|---|---|
| Durable peer token appears as false live presence | Presence comes from authenticated DataChannel open/close and an idempotent live-peer registry | 3 |
| Duplicate close/ICE callbacks emit duplicate leave events | One idempotent `remove_guest` path emits only when removal succeeds | 3 |
| Chat payload reaches input parser or delays input | Dedicated reliable room channel or strictly isolated text command class with bounds/rate limits | 4 |
| HTML/script in chat | Plain-text rendering only; no HTML sinks | 4 |
| Stale/unauthorized room participant posts chat | Validate current session-bound peer capability server-side/runtime-side | 4 |
| Cross-account/server/game save access | Bind transfer capability to exact account, server, game hash, operation, and expiry | 5 |
| Save upload destroys current data | Size-limit, stage, validate, and atomically replace; never auto-load | 5 |
| Player/spectator invokes host saves | Retain server/runtime capability enforcement and add negative tests | 2, 5 |
| MUI panel disappears in fullscreen | Portal container is the fullscreen `GameStage` subtree | 2, 6 |

---

## Story 1: Create the MUI player workspace and scoped fullscreen stage

**Objective:** Make Room view a normal application page and make fullscreen contain only the immersive game stage.

**Primary files:**

- Modify: `sc-web/components/PlayerShell.tsx`
- Modify: `sc-web/components/GamePlayer.tsx`
- Modify: `sc-web/components/GamePlayer.module.css`
- Create: `sc-web/components/player/PlayerWorkspace.tsx`
- Create: `sc-web/components/player/GameStage.tsx`
- Create: `sc-web/components/player/PlayerActionBar.tsx`
- Test: `sc-web/tests/ui/player-workspace.test.tsx`
- Test: browser player layout/fullscreen coverage under `e2e/`

**MUI mapping:**

- Page margins: `Container`
- Desktop game/room grid: `Box` with CSS grid in `sx`
- Stage frame: `Paper`
- Title/status/actions: `Stack`, `Typography`, `Chip`, `Button`, `IconButton`, `Tooltip`
- Desktop auxiliary rail: `Paper`
- Tablet/mobile mode switcher: `Tabs`, `Tab`
- Mobile auxiliary content: `Drawer`
- Loading/error state: `Skeleton`, `CircularProgress`, `Alert`
- Breakpoint selection: `useTheme`, `useMediaQuery`

**Acceptance criteria:**

- Windowed player renders shared navigation and a bounded game stage rather than video-only viewport chrome.
- Video maintains source aspect ratio at desktop, tablet, and phone widths.
- `requestFullscreen()` targets `GameStage`, not the document root.
- Room rail/navigation are absent in fullscreen.
- Leaving fullscreen restores the same session, selected workspace panel, and focus context.
- The app never forces fullscreen or orientation lock before an explicit user action.
- Existing stream startup, reconnect, input, and cleanup behavior is unchanged.

**Verification:** focused Vitest RED/GREEN, production build, Firefox/Chromium browser checks at 1440×900, 1024×768, 768×1024, 390×844, and 844×390.

---

## Story 2: Convert existing player controls and panels to MUI

**Objective:** Give Room view and fullscreen one MUI-based control vocabulary before adding new room features.

**Primary files:**

- Modify: `sc-web/components/OptionsOverlay.tsx`
- Modify: `sc-web/components/ControllerLayoutPanel.tsx`
- Modify: `sc-web/components/GamePlayerRemapPanel.tsx`
- Modify: `sc-web/components/GamePlayer.tsx`
- Create: `sc-web/components/player/PlayerOptionsPanel.tsx`
- Create: `sc-web/components/player/PlayerStatsPanel.tsx`
- Test: `sc-web/tests/ui/player-chrome-options.test.tsx`
- Test: browser fullscreen-panel coverage under `e2e/`

**MUI mapping:**

- Room-view action strip: `Paper`, `Stack`, `Button`, `IconButton`
- Options: responsive `Drawer`/`Dialog`
- Option hierarchy: `List`, `ListSubheader`, `ListItemButton`, `ListItemIcon`, `ListItemText`
- Controller settings: `Dialog`, `Stack`, `Slider`, `Switch`, `FormControlLabel`
- Key remapping: `Dialog`, `Table`, `Button`, `Chip`
- Diagnostics: `Drawer`, `Accordion`, `AccordionSummary`, `AccordionDetails`
- Confirmation: `DialogTitle`, `DialogContent`, `DialogActions`
- Feedback: `Snackbar`, `Alert`
- Roles: `Chip`

**Acceptance criteria:**

- No page-local button/modal/menu implementation remains where MUI provides the behavior.
- Fullscreen panels render inside the fullscreen subtree and remain interactive.
- Escape closes the topmost panel before exiting fullscreen.
- Dialog/Drawer focus is trapped and trigger focus is restored.
- Blocking panels suspend and release touch input unconditionally.
- Existing role-specific save/load/restart/eject/diagnostic controls remain correctly gated by capabilities.

---

## Story 3: Add authoritative live room presence

**Objective:** Display the host, players, and spectators who are actually connected to the current runtime room.

**Primary files:**

- Modify: `sc-server/src/commands/game.rs`
- Modify: relevant DataChannel lifecycle module under `sc-server/src/commands/`
- Modify: `sc-web/public/player/play-v2.js` source module or canonical player library source
- Modify: `sc-web/components/GamePlayer.tsx`
- Create: `sc-web/components/player/RoomPresence.tsx`
- Test: Rust peer-lifecycle tests
- Test: player callback forwarding tests
- Test: `sc-web/tests/ui/room-presence.test.tsx`

**MUI mapping:**

- Room region: `Paper`
- Participant list: `List`
- Participant row: `ListItem`, `ListItemAvatar`, `ListItemText`
- Identity: `Avatar`
- Role: `Chip`
- Connection status: `Badge` or secondary `Chip`
- Empty/loading: `Alert`, `Skeleton`
- Fullscreen join/leave event: `Snackbar`, `Alert`

**Protocol contract:**

```json
{"cmd":"peer_presence","event":"joined","seat":1}
{"cmd":"peer_presence","event":"left","seat":1}
```

Add a privacy-minimized current-presence snapshot after host/client authentication for reconnects. Do not expose peer tokens, room tokens, client IDs, addresses, or stable connection metadata.

**Acceptance criteria:**

- DataChannel open emits one join event after authentication.
- DataChannel close and ICE failure converge on one idempotent removal path.
- Duplicate cleanup emits no duplicate leave event.
- Reconnecting clients receive a current presence snapshot.
- Players and spectators are visibly distinct.
- Fullscreen shows brief join/leave feedback but never mounts the full room rail.

---

## Story 4: Add bounded ephemeral room chat

**Objective:** Let currently connected room participants communicate without leaving play or affecting game input.

**Primary files:**

- Modify: runtime DataChannel handling under `sc-server/src/commands/`
- Modify: canonical browser player/DataChannel parser
- Create: `sc-web/components/player/RoomChat.tsx`
- Modify: `sc-web/components/player/PlayerWorkspace.tsx`
- Test: Rust authorization/rate/payload tests
- Test: parser/callback tests
- Test: `sc-web/tests/ui/room-chat.test.tsx`
- Test: browser keyboard/input-isolation coverage

**MUI mapping:**

- Chat region: `Paper`, `Stack`
- Message history: `List`, `ListItem`, `ListItemText`
- Sender: `Avatar`, `Typography`
- Composer: `TextField`
- Send: `IconButton` with `Send` icon
- Unread count: `Badge`
- Validation: `FormHelperText`
- Reconnect/progress: `LinearProgress`, `Alert`
- Failure/compact fullscreen notification: `Snackbar`, `Alert`

**Behavioral contract:**

- Room-scoped and ephemeral; destroyed when the session ends.
- Plain text only, bounded length, bounded in-memory history, and server/runtime rate limits.
- Connected room participants only; stale capabilities fail closed.
- Reliable ordered transport isolated from binary controller input parsing.
- Enter sends; Shift+Enter creates a newline.
- Game input resumes when the composer loses focus.

**Acceptance criteria:**

- Chat traffic cannot be classified as controller input or delay the input path.
- Unauthorized/stale peers cannot post or fetch history.
- Mobile virtual keyboard does not hide the composer.
- Assistive announcements do not steal focus or repeatedly reread history.
- Fullscreen shows only an optional compact notification.

---

## Story 5: Build the MUI Save Center and safe save transfer

**Objective:** Replace the small save overlay with a persistent host-authorized Save Center that distinguishes SRAM from emulator snapshots.

**Primary files:**

- Modify: `sc-web/components/GamePlayer.tsx`
- Create: `sc-web/components/player/SaveCenter.tsx`
- Create/modify: capability and signaling API routes under `sc-web/app/api/servers/[server_id]/`
- Modify: save/runtime handlers in `sc-server/src/commands/save_handlers.rs`
- Modify: `sc-server/src/saves.rs`
- Extend/reuse: existing transfer protocol modules where appropriate
- Test: API authorization tests
- Test: Rust atomic import/export tests
- Test: browser transfer tests
- Test: `sc-web/tests/ui/save-center.test.tsx`

**MUI mapping:**

- Save category switcher: `Tabs`, `Tab`
- Desktop snapshot history: `TableContainer`, `Table`, `TableHead`, `TableBody`, `TableRow`, `TableCell`
- Mobile history: `List`, `ListItem`, `ListItemText`
- Actions: `Button`, `IconButton`, `Tooltip`
- Row overflow: `Menu`, `MenuItem`
- Upload chooser: `Button component="label"` with a native file input
- Progress: `LinearProgress`
- Compatibility warning: `Alert`
- Replacement confirmation: `Dialog`
- Empty state: `Paper`, `Typography`, `Button`
- Result feedback: `Snackbar`, `Alert`

**Delivery order:**

1. Preserve and expose the existing acknowledged runtime snapshot stack in the persistent workspace.
2. Add SRAM download/upload first because it is more portable.
3. Add snapshot export/import only with game hash, platform, core, core version, timestamp, and size metadata.

**Acceptance criteria:**

- Host authority is required at the server/runtime boundary for every save operation.
- Player/spectator manipulation fails closed.
- File bodies use a direct browser↔server data plane and do not transit through `sc-web`.
- Uploads are size-limited, staged, validated, and atomically activated.
- Upload never auto-loads into a running core.
- Failed uploads preserve the previous save.
- Incompatible snapshots warn and require an explicit confirmation path.
- Progress/success/timeout/failure text reflects acknowledged runtime outcomes.

---

## Story 6: Close responsive, accessibility, and integration gaps

**Objective:** Verify the complete workspace across roles, routes, breakpoints, reconnects, and fullscreen without turning the final story into a deferred accessibility retrofit.

**Primary files:**

- Modify only integration points found by the acceptance sweep
- Add browser tests under `e2e/`
- Add/extend `sc-web/tests/ui/` regression tests
- Update player documentation if public behavior or shortcuts change

**MUI mapping:**

- Desktop side rail: `Paper`, grid `Box`
- Tablet lower workspace: `Tabs`, `Tab`, `Paper`
- Mobile auxiliary surface: `Drawer`
- Compact primary actions: `BottomNavigation`, `BottomNavigationAction`, or compact `Paper` action strip based on browser testing
- Overflow: `Menu`, `MenuItem`
- Breakpoints: `useMediaQuery`
- Loading: `Skeleton`
- Announcements: `Snackbar`, `Alert`

**Verification matrix:**

- Desktop 1440×900 and 1024×768
- Tablet 768×1024 and 1024×768
- Mobile portrait 390×844
- Mobile landscape 844×390
- Keyboard-only and touch
- Reduced motion
- Fullscreen enter/exit with an MUI panel
- Reconnect while Room, Chat, and Saves are selected
- Host, player, spectator
- Cloud short-code route, private room route, and LAN-proxied route
- Chromium and Firefox; mobile Safari where available

**Acceptance criteria:**

- No two-axis unreachable content.
- Focus order follows visible layout.
- All icon-only actions have accessible names and tooltips.
- Hidden/auto-hidden controls are inert, not merely transparent.
- Touch targets meet 44px minimum and safe-area constraints.
- Reduced motion disables nonessential animation.
- No duplicate controls exist between action bar, options, Room, Chat, or Save Center.
- Full production build and canonical test suites pass at the immutable final HEAD.

---

## Dependency graph

```text
PR #792 shared navigation
          |
          v
Story 1 workspace/fullscreen boundary
          |
          v
Story 2 MUI control/panel consolidation
          |
          +------------------+
          v                  v
Story 3 live presence    Story 5 Save Center
          |
          v
Story 4 room chat
          |                  |
          +--------+---------+
                   v
Story 6 integration closure
```

Stories 3 and 5 may proceed in parallel after Story 2. Story 4 depends on the authenticated live-peer model established by Story 3. Story 6 depends on every preceding story.

## Per-story quality gates

- Focused test demonstrates RED against the previous behavior and GREEN at the story tip.
- `pnpm run lint`
- `pnpm test`
- `pnpm run build`
- Rust stories: focused tests, `cargo test -p sc-server`, and `cargo clippy -p sc-server --all-targets -- -D warnings`
- `git diff --check`
- Real browser verification at the affected breakpoints and routes
- Independent spec-compliance and code-quality reviews against the exact immutable PR HEAD
- No merge until required CI checks pass against that same HEAD
