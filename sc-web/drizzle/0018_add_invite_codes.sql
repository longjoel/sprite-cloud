BEGIN;

CREATE TABLE IF NOT EXISTS invite_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  code_prefix text NOT NULL,
  kind text NOT NULL DEFAULT 'server',
  server_id uuid REFERENCES servers(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id),
  max_redemptions integer NOT NULL DEFAULT 1 CONSTRAINT invite_codes_max_positive CHECK (max_redemptions > 0),
  redemption_count integer NOT NULL DEFAULT 0 CONSTRAINT invite_codes_redemption_nonnegative CHECK (redemption_count >= 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invite_codes_redemption_within_max CHECK (redemption_count <= max_redemptions),
  CONSTRAINT invite_codes_resource_shape CHECK (
    (kind = 'server' AND server_id IS NOT NULL AND created_by IS NOT NULL)
    OR (kind = 'bootstrap' AND server_id IS NULL AND created_by IS NULL AND max_redemptions = 1)
  )
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_server_created
  ON invite_codes(server_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_codes_one_bootstrap
  ON invite_codes(kind) WHERE kind = 'bootstrap';

CREATE TABLE IF NOT EXISTS invite_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code_id uuid NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invite_redemptions_invite_user UNIQUE (invite_code_id, user_id)
);

COMMIT;
