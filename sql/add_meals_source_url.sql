-- Adds a source URL for meals created via "import from link".
-- This allows the app to show a "source link" button on edit/detail screens.

ALTER TABLE meals
  ADD COLUMN IF NOT EXISTS source_url text;

