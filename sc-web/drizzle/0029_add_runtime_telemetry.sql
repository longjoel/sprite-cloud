ALTER TABLE servers ADD COLUMN IF NOT EXISTS runtime_telemetry jsonb NOT NULL DEFAULT '{}'::jsonb;
