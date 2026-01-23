-- Stores onboarding questionnaire answers for personalization.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_profile jsonb;

