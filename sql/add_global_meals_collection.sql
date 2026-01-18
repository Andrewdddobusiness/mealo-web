-- Global meal collections
-- Safe to run multiple times.

ALTER TABLE public.global_meals
  ADD COLUMN IF NOT EXISTS collection text;

-- Optional backfill: default collection to cuisine where missing.
UPDATE public.global_meals
SET collection = NULLIF(btrim(cuisine), '')
WHERE collection IS NULL
  AND cuisine IS NOT NULL
  AND btrim(cuisine) <> '';

CREATE INDEX IF NOT EXISTS global_meals_collection_idx
  ON public.global_meals (collection);
