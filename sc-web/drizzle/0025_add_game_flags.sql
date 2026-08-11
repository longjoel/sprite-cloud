-- Gateway-owned per-game flags for the Living Cabinet wall (#762):
-- always_on (resident session on the host) and public (broadcast on the
-- gateway's public wall). Admin-toggled on sc-web; kept OUT of server_games
-- (a full-replace cache pushed by sc-server) so a host sync can never wipe
-- an admin's toggle.
CREATE TABLE IF NOT EXISTS game_flags (
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  game_id text NOT NULL,
  always_on boolean NOT NULL DEFAULT false,
  public boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_game_flags_public
  ON game_flags (public)
  WHERE public = true;
