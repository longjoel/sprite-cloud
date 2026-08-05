-- Add minted_via_proxy flag to short_codes so the bearer override in
-- resolveShortCodeHostUser can be scoped to proxy-minted codes only.
ALTER TABLE short_codes
  ADD COLUMN IF NOT EXISTS minted_via_proxy boolean DEFAULT false NOT NULL;
