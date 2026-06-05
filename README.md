# Games Vault

Games Vault is a personal game-library and arcade server. It pairs the Games Vault web app with the Nosebleed/libretro runtime so a stored library can be browsed, watched, and played from the browser.

## User type feature matrix

Legend: Yes = available, No = unavailable, Scoped = available only in the room/profile scope described.

- Anonymous viewer
  - Browse library: Yes
  - Watch active room/session: Yes
  - Watch arcade cabinets: Yes
  - Controller input / player seat: No
  - Create normal game session: No
  - Chat: No
  - Share links: No
  - Battery saves: No
  - Admin/library management: No

- Player profile
  - Browse library: Yes
  - Watch active room/session: Yes
  - Watch arcade cabinets: Yes
  - Controller input / player seat: Yes, when a player seat is available
  - Create normal game session: Yes
  - Join arcade cabinet as player: Yes, when a player seat is available
  - Chat: Yes
  - Share links: Scoped; own active room only
  - Battery saves: Yes
  - Admin/library management: No

- Admin profile
  - Browse library: Yes
  - Watch active room/session: Yes
  - Watch arcade cabinets: Yes
  - Controller input / player seat: Yes, when a player seat is available
  - Create normal game session: Yes
  - Join arcade cabinet as player: Yes, when a player seat is available
  - Chat: Yes
  - Share links: Yes, for any active room
  - Battery saves: Yes
  - Admin/library management: Yes
  - Additional admin operations: manage sources, jobs, downloads, profiles/invites, system files, system/core mappings, arcade cabinets, Nosebleed sessions, and setup/sync jobs

- Spectator guest
  - Browse library: Scoped; created from a room share link and intended for the shared room
  - Watch active room/session: Yes, for the shared room
  - Watch arcade cabinets: Scoped; spectator-only unless a shared room grants player access
  - Controller input / player seat: No
  - Create normal game session: No
  - Chat: Yes
  - Share links: No
  - Battery saves: No
  - Admin/library management: No

- Player guest
  - Browse library: Scoped; created from a room share link and intended for the shared room
  - Watch active room/session: Yes, for the shared room
  - Watch arcade cabinets: Scoped; only where the redeemed share grants play
  - Controller input / player seat: Scoped; shared room only, when a player seat is available
  - Create normal game session: No
  - Chat: Yes
  - Share links: No
  - Battery saves: No
  - Admin/library management: No

## Permission model notes

- Global access modes are `Viewer`, `Player`, and `Admin`.
- Anonymous users are viewers.
- Normal signed-in non-admin profiles are players.
- Admin profiles are admins.
- Ephemeral guest profiles created by share links are global viewers, then receive room-scoped play only through the redeemed share grant.
- Chat is allowed for any current profile, including ephemeral guests, but not for anonymous viewers.
- Battery-save upload/history/download/delete/restore actions require a non-ephemeral profile.
- Admin/library management routes require admin access.
- Nosebleed input routes should use room/session-scoped play checks, not only global signed-in status.
