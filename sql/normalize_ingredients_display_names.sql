-- Normalize ingredient display names for consistent casing.
-- Safe to run multiple times.

UPDATE public.ingredients
SET
  name = initcap(name_normalized),
  updated_at = now()
WHERE name = lower(name);

