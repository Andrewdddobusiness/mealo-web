-- Track whether a user has ever unlocked the app by starting a trial (or otherwise validating a subscription).
-- Existing users are grandfathered in (set to true).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS has_had_trial boolean;

UPDATE users
SET has_had_trial = true
WHERE has_had_trial IS NULL;

ALTER TABLE users
  ALTER COLUMN has_had_trial SET DEFAULT false;

ALTER TABLE users
  ALTER COLUMN has_had_trial SET NOT NULL;

