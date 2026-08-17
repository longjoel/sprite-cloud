CREATE OR REPLACE FUNCTION try_parse_jsonb(input text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
BEGIN
  RETURN input::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_commands_server_id
  ON commands (server_id);

CREATE INDEX IF NOT EXISTS idx_commands_payload_user_id
  ON commands ((payload->>'user_id'))
  WHERE jsonb_typeof(payload) = 'object';

CREATE INDEX IF NOT EXISTS idx_commands_payload_authorized_user_id
  ON commands ((payload->>'authorized_user_id'))
  WHERE jsonb_typeof(payload) = 'object';

CREATE INDEX IF NOT EXISTS idx_commands_payload_session_id
  ON commands ((payload->>'session_id'))
  WHERE jsonb_typeof(payload) = 'object';

CREATE INDEX IF NOT EXISTS idx_commands_string_payload_user_id
  ON commands ((try_parse_jsonb(payload#>>'{}')->>'user_id'))
  WHERE jsonb_typeof(payload) = 'string';

CREATE INDEX IF NOT EXISTS idx_commands_string_payload_authorized_user_id
  ON commands ((try_parse_jsonb(payload#>>'{}')->>'authorized_user_id'))
  WHERE jsonb_typeof(payload) = 'string';

CREATE INDEX IF NOT EXISTS idx_commands_string_payload_session_id
  ON commands ((try_parse_jsonb(payload#>>'{}')->>'session_id'))
  WHERE jsonb_typeof(payload) = 'string';
