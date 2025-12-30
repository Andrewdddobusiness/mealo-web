-- Ingredients table (global + per-user suggestions)
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.ingredients (
  id text PRIMARY KEY,
  name text NOT NULL,
  name_normalized text NOT NULL,
  category text,
  is_global boolean NOT NULL DEFAULT false,
  created_by text REFERENCES public.users(id) ON DELETE CASCADE,
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingredients_name_normalized_idx
  ON public.ingredients (name_normalized);

CREATE INDEX IF NOT EXISTS ingredients_created_by_idx
  ON public.ingredients (created_by);

CREATE INDEX IF NOT EXISTS ingredients_is_global_idx
  ON public.ingredients (is_global);

-- Enforce uniqueness for globals and per-user suggestions.
CREATE UNIQUE INDEX IF NOT EXISTS ingredients_global_name_normalized_uniq
  ON public.ingredients (name_normalized)
  WHERE (is_global = true);

CREATE UNIQUE INDEX IF NOT EXISTS ingredients_user_name_normalized_uniq
  ON public.ingredients (created_by, name_normalized)
  WHERE (is_global = false);

-- Seed a starter global list from existing global meals.
-- (Uses deterministic IDs so this is idempotent without requiring uuid extensions.)
WITH extracted AS (
  SELECT
    CASE
      WHEN jsonb_typeof(elem) = 'string' THEN elem #>> '{}'
      WHEN jsonb_typeof(elem) = 'object' THEN elem ->> 'name'
      ELSE NULL
    END AS name,
    CASE
      WHEN jsonb_typeof(elem) = 'object' THEN elem ->> 'category'
      ELSE NULL
    END AS category
  FROM public.global_meals gm,
  LATERAL jsonb_array_elements(gm.ingredients) elem
),
normalized AS (
  SELECT
    trim(regexp_replace(lower(name), '\s+', ' ', 'g')) AS name_normalized,
    initcap(trim(regexp_replace(lower(name), '\s+', ' ', 'g'))) AS display_name,
    MAX(NULLIF(trim(category), '')) AS category
  FROM extracted
  WHERE name IS NOT NULL AND btrim(name) <> ''
  GROUP BY trim(regexp_replace(lower(name), '\s+', ' ', 'g'))
)
INSERT INTO public.ingredients (id, name, name_normalized, category, is_global, created_by, use_count, last_used_at)
SELECT
  'ing_global_' || md5(name_normalized),
  display_name,
  name_normalized,
  category,
  true,
  NULL,
  0,
  NULL
FROM normalized
ON CONFLICT (name_normalized) WHERE (is_global = true) DO UPDATE SET
  name = CASE
    WHEN ingredients.name = lower(ingredients.name) THEN EXCLUDED.name
    ELSE ingredients.name
  END,
  category = COALESCE(ingredients.category, EXCLUDED.category),
  updated_at = now();

-- Optional: Backfill per-user suggestions from existing meals (helps autocomplete immediately).
WITH extracted AS (
  SELECT
    m.created_by AS user_id,
    CASE
      WHEN jsonb_typeof(elem) = 'string' THEN elem #>> '{}'
      WHEN jsonb_typeof(elem) = 'object' THEN elem ->> 'name'
      ELSE NULL
    END AS name,
    CASE
      WHEN jsonb_typeof(elem) = 'object' THEN elem ->> 'category'
      ELSE NULL
    END AS category
  FROM public.meals m,
  LATERAL jsonb_array_elements(m.ingredients) elem
  WHERE m.created_by IS NOT NULL
),
normalized AS (
  SELECT
    user_id,
    trim(regexp_replace(lower(name), '\s+', ' ', 'g')) AS name_normalized,
    initcap(trim(regexp_replace(lower(name), '\s+', ' ', 'g'))) AS display_name,
    MAX(NULLIF(trim(category), '')) AS category,
    COUNT(*)::int AS use_count
  FROM extracted
  WHERE name IS NOT NULL AND btrim(name) <> ''
  GROUP BY user_id, trim(regexp_replace(lower(name), '\s+', ' ', 'g'))
)
INSERT INTO public.ingredients (id, name, name_normalized, category, is_global, created_by, use_count, last_used_at)
SELECT
  'ing_user_' || md5(user_id || ':' || name_normalized),
  display_name,
  name_normalized,
  category,
  false,
  user_id,
  use_count,
  now()
FROM normalized
ON CONFLICT (created_by, name_normalized) WHERE (is_global = false) DO UPDATE SET
  name = CASE
    WHEN ingredients.name = lower(ingredients.name) THEN EXCLUDED.name
    ELSE ingredients.name
  END,
  category = COALESCE(EXCLUDED.category, ingredients.category),
  use_count = GREATEST(ingredients.use_count, EXCLUDED.use_count),
  last_used_at = COALESCE(ingredients.last_used_at, EXCLUDED.last_used_at),
  updated_at = now();
