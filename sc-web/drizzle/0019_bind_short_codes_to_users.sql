BEGIN;

ALTER TABLE short_codes
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_short_codes_created_by
  ON short_codes(created_by);

COMMIT;
