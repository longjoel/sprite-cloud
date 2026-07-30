BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_commands_active_upgrade_per_server
  ON commands(server_id)
  WHERE type = 'upgrade_server' AND status IN ('pending', 'leased');

COMMIT;
