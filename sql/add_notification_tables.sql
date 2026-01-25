-- Adds push notification token storage + per-user notification settings + send dedupe log.

CREATE TABLE IF NOT EXISTS notification_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  household_id TEXT REFERENCES households(id) ON DELETE SET NULL,
  utc_offset_minutes INTEGER NOT NULL DEFAULT 0,
  quiet_hours_start INTEGER NOT NULL DEFAULT 22,
  quiet_hours_end INTEGER NOT NULL DEFAULT 8,
  max_per_day INTEGER NOT NULL DEFAULT 1,
  remind_today_missing BOOLEAN NOT NULL DEFAULT true,
  remind_tomorrow_missing BOOLEAN NOT NULL DEFAULT true,
  remind_miss_you BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  device_id TEXT,
  platform TEXT,
  disabled_at TIMESTAMP,
  last_seen_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_token_uniq
  ON push_tokens(token);

CREATE INDEX IF NOT EXISTS push_tokens_user_id_idx
  ON push_tokens(user_id);

CREATE INDEX IF NOT EXISTS push_tokens_user_id_device_id_idx
  ON push_tokens(user_id, device_id);

CREATE TABLE IF NOT EXISTS notification_sends (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id TEXT REFERENCES households(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  day_key TEXT NOT NULL,
  date_key TEXT,
  meta JSONB,
  created_at TIMESTAMP DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_sends_user_type_day_uniq
  ON notification_sends(user_id, type, day_key);

CREATE INDEX IF NOT EXISTS notification_sends_user_id_idx
  ON notification_sends(user_id);

CREATE INDEX IF NOT EXISTS notification_sends_user_id_day_key_idx
  ON notification_sends(user_id, day_key);

