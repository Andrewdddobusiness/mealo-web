-- Adds user achievements (unlocked awards + progress).

CREATE TABLE IF NOT EXISTS user_achievements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  unlocked_at TIMESTAMP,
  meta JSONB,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_achievements_user_id_achievement_id_uniq
  ON user_achievements(user_id, achievement_id);

CREATE INDEX IF NOT EXISTS user_achievements_user_id_idx
  ON user_achievements(user_id);

CREATE INDEX IF NOT EXISTS user_achievements_achievement_id_idx
  ON user_achievements(achievement_id);

