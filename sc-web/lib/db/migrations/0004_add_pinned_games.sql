CREATE TABLE IF NOT EXISTS pinned_games (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  game_id UUID NOT NULL REFERENCES games(id),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pinned_games_user_game UNIQUE (user_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_pinned_games_user_pos ON pinned_games (user_id, position);
