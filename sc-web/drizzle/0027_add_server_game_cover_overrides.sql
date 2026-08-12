CREATE TABLE IF NOT EXISTS "server_game_cover_overrides" (
  "server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "game_id" text NOT NULL,
  "source_type" text NOT NULL,
  "asset_id" text NOT NULL,
  "poster_asset_id" text NOT NULL,
  "media_type" text NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "byte_size" integer NOT NULL,
  "animated" boolean NOT NULL DEFAULT false,
  "frame_count" integer NOT NULL DEFAULT 1,
  "provider_key" text,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "server_game_cover_overrides_pkey" PRIMARY KEY ("server_id", "game_id"),
  CONSTRAINT "server_game_cover_source_type" CHECK ("source_type" IN ('retroarch', 'upload'))
);
CREATE INDEX IF NOT EXISTS "idx_server_game_cover_overrides_asset" ON "server_game_cover_overrides" ("asset_id");
