-- Idempotent performance indexes for Mealo API hot paths.
-- Safe to run multiple times.
--
-- Notes:
-- - `CONCURRENTLY` avoids long write locks but cannot run inside a transaction block.
-- - If your SQL runner wraps statements in a transaction, remove `CONCURRENTLY`.

-- Speeds up /api/households and /api/meals (membership lookups).
CREATE INDEX CONCURRENTLY IF NOT EXISTS household_members_user_id_idx
  ON public.household_members USING btree (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS household_members_user_id_household_id_idx
  ON public.household_members USING btree (user_id, household_id);

-- Speeds up owner household listing.
CREATE INDEX CONCURRENTLY IF NOT EXISTS households_owner_id_idx
  ON public.households USING btree (owner_id);

-- Speeds up fetching meals for many households.
CREATE INDEX CONCURRENTLY IF NOT EXISTS meals_household_id_idx
  ON public.meals USING btree (household_id);

-- Speeds up imported meal de-dupe.
CREATE INDEX CONCURRENTLY IF NOT EXISTS meals_from_global_meal_id_idx
  ON public.meals USING btree (from_global_meal_id);

-- Speeds up fetching all planned meals per household.
CREATE INDEX CONCURRENTLY IF NOT EXISTS plans_household_id_idx
  ON public.plans USING btree (household_id);

-- Speeds up joins from plans -> meals.
CREATE INDEX CONCURRENTLY IF NOT EXISTS plans_meal_id_idx
  ON public.plans USING btree (meal_id);

