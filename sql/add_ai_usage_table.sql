-- Adds monthly AI usage tracking (per user, per feature).

CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  period TEXT NOT NULL, -- YYYY-MM (UTC)
  used INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_user_feature_period_uniq
  ON ai_usage(user_id, feature, period);

CREATE INDEX IF NOT EXISTS ai_usage_user_id_period_idx
  ON ai_usage(user_id, period);

CREATE INDEX IF NOT EXISTS ai_usage_feature_idx
  ON ai_usage(feature);

