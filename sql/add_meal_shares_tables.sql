CREATE TABLE IF NOT EXISTS meal_shares (
  id text PRIMARY KEY,
  token text NOT NULL,
  created_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_meal_id text REFERENCES meals(id) ON DELETE SET NULL,
  source_global_meal_id text REFERENCES global_meals(id) ON DELETE SET NULL,
  source_household_id text REFERENCES households(id) ON DELETE SET NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamp,
  revoked_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS meal_shares_token_uniq ON meal_shares(token);
CREATE INDEX IF NOT EXISTS meal_shares_created_by_idx ON meal_shares(created_by);
CREATE INDEX IF NOT EXISTS meal_shares_source_meal_id_idx ON meal_shares(source_meal_id);

CREATE TABLE IF NOT EXISTS meal_share_acceptances (
  id text PRIMARY KEY,
  share_id text NOT NULL REFERENCES meal_shares(id) ON DELETE CASCADE,
  accepted_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_meal_id text REFERENCES meals(id) ON DELETE SET NULL,
  household_id text REFERENCES households(id) ON DELETE SET NULL,
  accepted_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS meal_share_acceptances_share_id_accepted_by_uniq
  ON meal_share_acceptances(share_id, accepted_by);
CREATE INDEX IF NOT EXISTS meal_share_acceptances_share_id_idx ON meal_share_acceptances(share_id);
CREATE INDEX IF NOT EXISTS meal_share_acceptances_accepted_by_idx ON meal_share_acceptances(accepted_by);
