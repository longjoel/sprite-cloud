-- Add DAT verification evidence to server_games: canonical identity and
-- provenance supplied by the paired server's DAT catalog. All columns are
-- nullable; a row with verification_state = NULL has no DAT evidence.
ALTER TABLE server_games
  ADD COLUMN IF NOT EXISTS verification_state text,
  ADD COLUMN IF NOT EXISTS canonical_title text,
  ADD COLUMN IF NOT EXISTS canonical_platform text,
  ADD COLUMN IF NOT EXISTS region text,
  ADD COLUMN IF NOT EXISTS revision text,
  ADD COLUMN IF NOT EXISTS confidence text,
  ADD COLUMN IF NOT EXISTS catalog_name text,
  ADD COLUMN IF NOT EXISTS catalog_version text,
  ADD COLUMN IF NOT EXISTS catalog_sha256 text,
  ADD COLUMN IF NOT EXISTS verification_source_name text,
  ADD COLUMN IF NOT EXISTS enriched_at text;
