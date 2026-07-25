-- Add server-owned game catalog cache on sc-web.
-- sc-server pushes game metadata (id, name, platform, max_players) on startup
-- and after re-scans. The cloud /api/games endpoint queries this table.
-- ROM paths, file hashes, and library preferences stay on sc-server.
CREATE TABLE "server_games" (
  "server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "game_id" text NOT NULL,
  "name" text NOT NULL,
  "platform" text NOT NULL DEFAULT 'Unknown',
  "max_players" integer NOT NULL DEFAULT 1,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("server_id", "game_id")
);

CREATE INDEX "idx_server_games_server" ON "server_games" ("server_id");
CREATE INDEX "idx_server_games_name" ON "server_games" ("name");
