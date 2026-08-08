-- Per-game resident session seat cap (#762). NULL means "host default (4)".
-- Mirrors the live-applied free_play column (also missing from 0025): kept in
-- game_flags so a host sync can never wipe an admin's seat setting.
ALTER TABLE game_flags ADD COLUMN IF NOT EXISTS max_seats integer;
