-- 0015: Favorites + Recent Plays tables

CREATE TABLE IF NOT EXISTS "favorites" (
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "game_id" uuid NOT NULL REFERENCES "games"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "favorites_user_game" UNIQUE ("user_id", "game_id")
);

CREATE TABLE IF NOT EXISTS "recent_plays" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "game_id" uuid NOT NULL REFERENCES "games"("id"),
  "played_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_recent_plays_user_played"
  ON "recent_plays" ("user_id", "played_at" DESC);
